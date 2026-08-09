import {
  OCX_SECTION_MARKER,
  hasInjectedOpenaiBaseUrl,
  providerTableString,
  rootTomlString,
} from "./injected-marker";

export const DEFAULT_SPLIT_BRIDGE_PORT = 10101;
export const DEFAULT_LEGACY_GATEWAY_PORT = 10100;

export type CodexSplitState = "native" | "split" | "legacy-local";

export type CodexSplitStateReason =
  | "no-bridge-routing"
  | "user-owned-openai-base-url"
  | "split-route"
  | "legacy-route"
  | "legacy-route-without-marker"
  | "bridge-marker-url-mismatch"
  | "legacy-route-url-mismatch";

export interface CodexSplitStateObservation {
  readonly state: CodexSplitState;
  readonly owned: boolean;
  readonly baseUrl: string | null;
  readonly reason: CodexSplitStateReason;
}

export interface CodexSplitStateOptions {
  readonly splitPort?: number;
  readonly legacyPort?: number;
  readonly splitHost?: string;
  readonly legacyHost?: string;
}

export interface BridgeRoutingRestoreResult {
  readonly content: string;
  readonly changed: boolean;
  /** True when a legacy route was found but ownership proof was insufficient. */
  readonly refused: boolean;
  readonly state: CodexSplitState;
}

function canonicalRoute(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.protocol}//${url.host.toLowerCase()}${pathname}`;
  } catch {
    return null;
  }
}

function expectedRoute(host: string, port: number): string {
  const normalizedHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return canonicalRoute(`http://${normalizedHost}:${port}/v1`)!;
}

function normalizedLines(content: string): { lines: string[]; eol: "\n" | "\r\n" } {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return { lines: content.replace(/\r\n/g, "\n").split("\n"), eol };
}

function firstTableIndex(lines: readonly string[]): number {
  const index = lines.findIndex(line => /^\s*\[/.test(line));
  return index === -1 ? lines.length : index;
}

function hasOwnedLegacyProviderBlock(content: string): boolean {
  const { lines } = normalizedLines(content);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (lines[index]!.trim() === OCX_SECTION_MARKER
      && lines[index + 1]!.trim() === "[model_providers.opencodex]") {
      return true;
    }
  }
  return false;
}

function optionsWithDefaults(options: CodexSplitStateOptions): Required<CodexSplitStateOptions> {
  return {
    splitPort: options.splitPort ?? DEFAULT_SPLIT_BRIDGE_PORT,
    legacyPort: options.legacyPort ?? DEFAULT_LEGACY_GATEWAY_PORT,
    splitHost: options.splitHost ?? "127.0.0.1",
    legacyHost: options.legacyHost ?? "127.0.0.1",
  };
}

/**
 * Classify the active Codex routing without treating a matching URL as ownership.
 * The marker and the expected route must agree before any restore may touch bytes.
 */
export function classifyCodexSplitState(
  content: string,
  options: CodexSplitStateOptions = {},
): CodexSplitStateObservation {
  const resolved = optionsWithDefaults(options);
  const rootBaseUrl = rootTomlString(content, "openai_base_url");
  const rootBase = canonicalRoute(rootBaseUrl);
  const splitBase = expectedRoute(resolved.splitHost, resolved.splitPort);
  const legacyBase = expectedRoute(resolved.legacyHost, resolved.legacyPort);

  if (rootBaseUrl !== null) {
    if (hasInjectedOpenaiBaseUrl(content)) {
      if (rootBase === splitBase) {
        return { state: "split", owned: true, baseUrl: rootBaseUrl, reason: "split-route" };
      }
      if (rootBase === legacyBase) {
        return { state: "legacy-local", owned: true, baseUrl: rootBaseUrl, reason: "legacy-route" };
      }
      return {
        state: "legacy-local",
        owned: false,
        baseUrl: rootBaseUrl,
        reason: "bridge-marker-url-mismatch",
      };
    }
    return {
      state: "native",
      owned: false,
      baseUrl: rootBaseUrl,
      reason: "user-owned-openai-base-url",
    };
  }

  const provider = rootTomlString(content, "model_provider");
  const providerBaseUrl = provider === "opencodex"
    ? providerTableString(content, "opencodex", "base_url")
    : null;
  if (provider === "opencodex" && providerBaseUrl !== null) {
    const providerBase = canonicalRoute(providerBaseUrl);
    const marked = hasOwnedLegacyProviderBlock(content);
    if (marked && providerBase === legacyBase) {
      return { state: "legacy-local", owned: true, baseUrl: providerBaseUrl, reason: "legacy-route" };
    }
    return {
      state: "legacy-local",
      owned: false,
      baseUrl: providerBaseUrl,
      reason: marked ? "legacy-route-url-mismatch" : "legacy-route-without-marker",
    };
  }

  return {
    state: "native",
    owned: false,
    baseUrl: null,
    reason: "no-bridge-routing",
  };
}

/** Read-only proof that Codex is pointed at the bridge's owned 10101 route. */
export function isSplitBridgeRoutingInjected(content: string, options: CodexSplitStateOptions = {}): boolean {
  const observation = classifyCodexSplitState(content, options);
  return observation.state === "split" && observation.owned;
}

function removeOwnedSplitRoot(content: string, expectedBase: string): { content: string; changed: boolean } {
  const { lines, eol } = normalizedLines(content);
  const rootEnd = firstTableIndex(lines);
  const kept: string[] = [];
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    if (index < rootEnd
      && lines[index]!.trim() === OCX_SECTION_MARKER
      && index + 1 < rootEnd
      && /^\s*openai_base_url\s*=/.test(lines[index + 1]!)
      && canonicalRoute(rootTomlString(`${lines[index + 1]}\n`, "openai_base_url")) === expectedBase) {
      changed = true;
      index += 1;
      continue;
    }
    kept.push(lines[index]!);
  }
  return { content: changed ? kept.join(eol) : content, changed };
}

function removeOwnedLegacyProvider(content: string): { content: string; changed: boolean } {
  const { lines, eol } = normalizedLines(content);
  const rootEnd = firstTableIndex(lines);
  const kept: string[] = [];
  let changed = false;
  let inOwnedProvider = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index < rootEnd && /^\s*model_provider\s*=\s*["']opencodex["']\s*$/.test(line)) {
      changed = true;
      continue;
    }
    if (!inOwnedProvider
      && line.trim() === OCX_SECTION_MARKER
      && index + 1 < lines.length
      && lines[index + 1]!.trim() === "[model_providers.opencodex]") {
      changed = true;
      inOwnedProvider = true;
      index += 1;
      continue;
    }
    if (inOwnedProvider) {
      if (/^\s*\[/.test(line)) {
        inOwnedProvider = false;
        kept.push(line);
      }
      continue;
    }
    kept.push(line);
  }
  return { content: changed ? kept.join(eol) : content, changed };
}

/**
 * Strip only routing keys proven to be owned by the split bridge. A legacy route
 * without its marker is reported as refused rather than guessed into ownership.
 */
export function restoreBridgeOwnedRouting(
  content: string,
  options: CodexSplitStateOptions = {},
): BridgeRoutingRestoreResult {
  const observation = classifyCodexSplitState(content, options);
  if (!observation.owned) {
    return {
      content,
      changed: false,
      refused: observation.state === "legacy-local",
      state: observation.state,
    };
  }

  const resolved = optionsWithDefaults(options);
  const expected = observation.state === "split"
    ? expectedRoute(resolved.splitHost, resolved.splitPort)
    : expectedRoute(resolved.legacyHost, resolved.legacyPort);
  const result = observation.state === "split"
    ? removeOwnedSplitRoot(content, expected)
    : removeOwnedLegacyProvider(content);
  return {
    content: result.content,
    changed: result.changed,
    refused: false,
    state: observation.state,
  };
}
