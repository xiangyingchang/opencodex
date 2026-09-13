/**
 * Per-server readiness gate for the opencodex proxy.
 *
 * `GET /healthz` answers "is the process alive and serving HTTP?" the instant the
 * listener binds. Readiness is stricter: the proxy is "ready" only after the
 * post-startup Codex catalog/config sync (`syncModelsToCodex`) has settled with
 * `ok=true` and no catalog-sync warning. Until then the process is live (Codex can
 * open a socket) but not ready (a request would race the sync or hit a stale
 * catalog), so clients should back off.
 *
 * Design contract (per P1 review):
 *  - NO module-global mutable state. Each `startServer` invocation gets its own
 *    private gate via `createReadinessGate()`, captured by that listener's
 *    closure. Starting/failing a second server in the same process can never
 *    reset or mutate the first server's gate.
 *  - Only the fixed sanitized status enum `pending | ready | failed` is stored
 *    and exposed. There is no `changedAt`, no free-form failure reason, no sync
 *    message, no warning text, no catalog path, no provider output, and no
 *    account data — those are private diagnostic data and are never exposed by
 *    `/readyz`.
 */

/** Sanitized readiness state. Exactly these three values, nothing else. */
export type ReadinessStatus = "pending" | "ready" | "failed";

export const DEFAULT_READINESS_MAX_ATTEMPTS = 3;
export const DEFAULT_READINESS_BACKOFF_MS = [100, 250] as const;

export type ReadinessSleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ReadinessRetryOptions {
  /** Total sync calls, including the first call. */
  maxAttempts?: number;
  /** Delay before attempt 2, 3, ...; the last value is reused if needed. */
  backoffMs?: readonly number[];
  /** One shutdown/recovery signal shared by sync and backoff. */
  signal?: AbortSignal;
  /** Test seam; production uses an abort-aware timer. */
  sleep?: ReadinessSleep;
}

interface ReadinessRunState {
  generation: number;
  inFlight?: Promise<SyncOutcomeLike | null>;
}

const READINESS_RUN_STATE = Symbol("readinessRunState");
type ReadinessGateWithRunState = ReadinessGate & {
  [READINESS_RUN_STATE]?: ReadinessRunState;
};

/**
 * Private per-server readiness controller. The status starts at `pending`.
 * `beginRecovery` is the only transition out of `failed`; this prevents a late
 * successful promise from jumping directly from `failed` to `ready`.
 */
export interface ReadinessGate {
  /** Current sanitized status. */
  getStatus(): ReadinessStatus;
  /** Mark the proxy ready (post-startup sync settled cleanly). */
  markReady(): void;
  /** Mark the proxy failed. No reason is stored or exposed. */
  markFailed(): void;
  /** Explicitly reopen a failed gate for one bounded recovery run. */
  beginRecovery?(): boolean;
}

/**
 * Create a fresh private gate for one `startServer` invocation. The returned
 * gate is the only way to read or mutate this server's readiness.
 */
export function createReadinessGate(): ReadinessGate {
  let status: ReadinessStatus = "pending";
  const runState: ReadinessRunState = { generation: 0 };
  const gate: ReadinessGateWithRunState = {
    getStatus: () => status,
    markReady: () => {
      // Keep the original one-shot semantics: a caller must explicitly open a
      // failed gate before a recovery run can publish ready.
      if (status === "pending") {
        status = "ready";
        runState.generation += 1;
      }
    },
    markFailed: () => {
      if (status === "pending") {
        status = "failed";
        runState.generation += 1;
      }
    },
    beginRecovery: () => {
      if (status !== "failed") return false;
      status = "pending";
      runState.generation += 1;
      return true;
    },
    [READINESS_RUN_STATE]: runState,
  };
  return gate;
}

/** Minimal shape of the post-startup sync outcome the gate cares about. */
export interface SyncOutcomeLike {
  ok?: boolean;
  warning?: string;
  /** Explicitly says that this failed outcome is safe to retry. */
  retryable?: boolean;
  /** #1046: whether the sync actually rewrote the on-disk catalog/cache. */
  catalogWritten?: boolean;
  cacheSynced?: boolean;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Readiness sync aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function normalizedAttempts(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_READINESS_MAX_ATTEMPTS;
  return Math.max(1, Math.floor(value!));
}

function normalizedDelay(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 0;
  return Math.max(0, Math.floor(value));
}

function delayForAttempt(backoffMs: readonly number[] | undefined, retryIndex: number): number {
  const delays = backoffMs && backoffMs.length > 0 ? backoffMs : DEFAULT_READINESS_BACKOFF_MS;
  return normalizedDelay(delays[Math.min(retryIndex, delays.length - 1)]);
}

function defaultReadinessSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason(signal!));
    };
    const onTimer = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(onTimer, ms);
  });
}

/**
 * Await a sync result without allowing a late promise to mutate readiness after
 * shutdown. The underlying provider operation may have its own timeout; this
 * boundary stops consuming its result as soon as the shared signal aborts.
 */
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    );
  });
}

function cleanOutcome(result: SyncOutcomeLike): boolean {
  return result.ok === true && (result.warning === undefined || result.warning === "");
}

function retryableOutcome(result: SyncOutcomeLike | null): boolean {
  // A thrown error or null means the sync did not produce a durable verdict;
  // treat that as transient. Structured failures must opt in explicitly.
  return result === null || result.retryable === true;
}

function readinessRunState(gate: ReadinessGate): ReadinessRunState {
  const withState = gate as ReadinessGateWithRunState;
  if (withState[READINESS_RUN_STATE]) return withState[READINESS_RUN_STATE]!;
  const state: ReadinessRunState = { generation: 0 };
  // Keep compatibility with legacy gate objects that only implement the three
  // original methods. The non-enumerable sidecar is per gate, not shared
  // readiness state, and does not alter the public /readyz representation.
  Object.defineProperty(withState, READINESS_RUN_STATE, {
    configurable: false,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

function publishReadinessIfCurrent(
  gate: ReadinessGate,
  state: ReadinessRunState,
  generation: number,
  ready: boolean,
): void {
  if (state.generation !== generation) return;
  if (ready) gate.markReady();
  else gate.markFailed();
}

async function executeStartupReadinessSync(
  gate: ReadinessGate,
  syncFn: (signal?: AbortSignal) => Promise<SyncOutcomeLike | null>,
  options: ReadinessRetryOptions,
  state: ReadinessRunState,
  generation: number,
): Promise<SyncOutcomeLike | null> {
  const maxAttempts = normalizedAttempts(options.maxAttempts);
  let lastResult: SyncOutcomeLike | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      throwIfAborted(options.signal);
      const result = await awaitWithAbort(Promise.resolve(syncFn(options.signal)), options.signal);
      lastResult = result;
      if (result !== null && cleanOutcome(result)) {
        throwIfAborted(options.signal);
        publishReadinessIfCurrent(gate, state, generation, true);
        return result;
      }
      if (!retryableOutcome(result) || attempt + 1 >= maxAttempts) {
        publishReadinessIfCurrent(gate, state, generation, false);
        return result;
      }
    } catch {
      // Abort is a terminal shutdown outcome, not a reason to enter another
      // backoff or invoke the provider again. Other throws are transient.
      if (options.signal?.aborted || attempt + 1 >= maxAttempts) {
        publishReadinessIfCurrent(gate, state, generation, false);
        return null;
      }
      lastResult = null;
    }

    try {
      const sleep = options.sleep ?? defaultReadinessSleep;
      await sleep(delayForAttempt(options.backoffMs, attempt), options.signal);
      throwIfAborted(options.signal);
    } catch {
      publishReadinessIfCurrent(gate, state, generation, false);
      return null;
    }
  }

  publishReadinessIfCurrent(gate, state, generation, false);
  return lastResult;
}

/**
 * Drive the gate from the post-startup sync. Awaits `syncFn`; the gate goes to
 * `ready` ONLY on `ok=true` with no nonempty warning. A throw, `null`, `ok=false`,
 * or a nonempty warning transitions to `failed` after its bounded retry policy.
 * A failed gate is first reopened through `failed -> pending`; no call can jump
 * directly from `failed` to `ready`. Returns the last raw sync outcome.
 */
export function runStartupReadinessSync(
  gate: ReadinessGate,
  syncFn: (signal?: AbortSignal) => Promise<SyncOutcomeLike | null>,
  options: ReadinessRetryOptions = {},
): Promise<SyncOutcomeLike | null> {
  const state = readinessRunState(gate);
  if (state.inFlight) return state.inFlight;

  // Recovery is explicit and only reopens a failed gate. A ready gate retains
  // the existing one-shot behavior unless its owner deliberately changes it.
  if (gate.getStatus() === "failed") gate.beginRecovery?.();

  const generation = ++state.generation;
  // Queue execution so the in-flight slot is visible before syncFn can
  // synchronously re-enter this function.
  const flight = Promise.resolve().then(() => executeStartupReadinessSync(
    gate,
    syncFn,
    options,
    state,
    generation,
  ));
  state.inFlight = flight;
  const clearFlight = () => {
    if (state.inFlight === flight) state.inFlight = undefined;
  };
  void flight.then(clearFlight, clearFlight);
  return flight;
}
