import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createReadinessGate,
  runStartupReadinessSync,
} from "../src/server/readiness";
import { syncCodexOnStartIfEnabled } from "../src/codex/desired-state";

const retryWithoutWallClock = {
  maxAttempts: 3,
  backoffMs: [0, 0],
  sleep: async () => {},
};

describe("readiness recovery state machine", () => {
  test("failed gate recovers through pending before it becomes ready", async () => {
    const gate = createReadinessGate();
    gate.markFailed();

    expect(gate.beginRecovery()).toBe(true);
    expect(gate.getStatus()).toBe("pending");

    await runStartupReadinessSync(gate, async () => ({ ok: true }));
    expect(gate.getStatus()).toBe("ready");
  });

  test("transient startup failure retries within one total attempt budget", async () => {
    const gate = createReadinessGate();
    let calls = 0;
    const sleeps: number[] = [];

    await runStartupReadinessSync(
      gate,
      async () => {
        calls += 1;
        if (calls < 3) return { ok: false, retryable: true };
        return { ok: true };
      },
      {
        ...retryWithoutWallClock,
        sleep: async (ms: number) => { sleeps.push(ms); },
      },
    );

    expect(calls).toBe(3);
    expect(sleeps).toEqual([0, 0]);
    expect(gate.getStatus()).toBe("ready");
  });

  test("permanent configuration failure does not consume retry attempts", async () => {
    const gate = createReadinessGate();
    let calls = 0;

    await runStartupReadinessSync(
      gate,
      async () => {
        calls += 1;
        return { ok: false, retryable: false };
      },
      retryWithoutWallClock,
    );

    expect(calls).toBe(1);
    expect(gate.getStatus()).toBe("failed");
  });

  test("abort during recovery backoff prevents another sync attempt", async () => {
    const gate = createReadinessGate();
    const controller = new AbortController();
    let calls = 0;
    let sleepCalls = 0;

    await runStartupReadinessSync(
      gate,
      async () => {
        calls += 1;
        return { ok: false, retryable: true };
      },
      {
        maxAttempts: 3,
        backoffMs: [100, 100],
        signal: controller.signal,
        sleep: async (_ms: number, signal: AbortSignal) => {
          sleepCalls += 1;
          controller.abort(new Error("shutdown"));
          if (!signal.aborted) throw new Error("test sleep did not observe abort");
        },
      },
    );

    expect(calls).toBe(1);
    expect(sleepCalls).toBe(1);
    expect(gate.getStatus()).toBe("failed");
  });

  test("startup integration retries a transient sync and exposes no provider call", async () => {
    const gate = createReadinessGate();
    let calls = 0;

    const result = await syncCodexOnStartIfEnabled(
      10100,
      { clientIntegrations: { codex: true } },
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("temporary catalog transport failure");
        return { ok: true };
      },
      gate,
      retryWithoutWallClock,
    );

    expect(result.ran).toBe(true);
    expect(calls).toBe(2);
    expect(gate.getStatus()).toBe("ready");
  });

  test("split mode does not publish ready when injection failed after a catalog write", async () => {
    const gate = createReadinessGate();
    const result = await syncCodexOnStartIfEnabled(
      10100,
      { clientIntegrations: { codex: true }, codexRoutingMode: "split" },
      async () => ({
        ok: false,
        warning: "injection failed",
        catalogWritten: true,
        cacheSynced: true,
      }),
      gate,
      { maxAttempts: 1, sleep: async () => {} },
    );

    expect(result).toMatchObject({ catalogWritten: true, cacheSynced: true });
    expect(gate.getStatus()).toBe("failed");
  });

  test("split mode keeps an unclassified warning failed after catalog/cache writes", async () => {
    const gate = createReadinessGate();
    await syncCodexOnStartIfEnabled(
      10100,
      { clientIntegrations: { codex: true }, codexRoutingMode: "split" },
      async () => ({
        warning: "catalog warning",
        catalogWritten: true,
        cacheSynced: true,
      }),
      gate,
      { maxAttempts: 1, sleep: async () => {} },
    );

    expect(gate.getStatus()).toBe("failed");
  });

  test("concurrent recovery calls share one in-flight sync", async () => {
    const gate = createReadinessGate();
    gate.markFailed();
    let calls = 0;
    let resolveSync!: (value: { ok: true }) => void;
    const sync = async () => {
      calls += 1;
      return new Promise<{ ok: true }>(resolve => { resolveSync = resolve; });
    };

    const first = runStartupReadinessSync(gate, sync);
    const second = runStartupReadinessSync(gate, sync);
    expect(second).toBe(first);
    await Promise.resolve();
    expect(calls).toBe(1);

    resolveSync({ ok: true });
    await Promise.all([first, second]);
    expect(gate.getStatus()).toBe("ready");
  });

  test("a stale completion cannot publish after a newer gate generation", async () => {
    const gate = createReadinessGate();
    gate.markFailed();
    let resolveSync!: (value: { ok: true }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => { markStarted = resolve; });

    const first = runStartupReadinessSync(gate, async () => {
      markStarted();
      return new Promise<{ ok: true }>(resolve => { resolveSync = resolve; });
    }, { maxAttempts: 1 });
    await started;

    // Invalidate the first recovery while its sync is still pending, then open
    // a newer generation. The first completion must not publish ready into it.
    gate.markFailed();
    expect(gate.beginRecovery()).toBe(true);
    resolveSync({ ok: true });
    await first;
    expect(gate.getStatus()).toBe("pending");

    await runStartupReadinessSync(gate, async () => ({ ok: true }), { maxAttempts: 1 });
    expect(gate.getStatus()).toBe("ready");
  });
});

describe("readiness recovery integration wiring", () => {
  const cliSource = readFileSync(join(import.meta.dir, "../src/cli/index.ts"), "utf8");

  test("startup owns an abort controller and cancels readiness retries during cleanup", () => {
    expect(cliSource).toContain("startupReadinessAbortController");
    expect(cliSource).toContain("startupReadinessAbortController.abort");
    expect(cliSource).toContain("signal: startupReadinessAbortController.signal");
  });
});
