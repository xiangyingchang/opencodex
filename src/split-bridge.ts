import type { Server } from "bun";
import { normalizeOpenAiResponsesForwardBody } from "./adapters/openai-responses";
import {
  DecompressedBodyTooLargeError,
  MAX_DECOMPRESSED_BODY_BYTES,
  readBoundedJsonRequestBody,
  UnsupportedContentEncodingError,
} from "./server/request-decompress";
import {
  SPLIT_BRIDGE_ACCOUNT_SELECTOR_HEADER,
  SPLIT_BRIDGE_ADMISSION_HEADER,
} from "./server/bridge-admission";
import {
  assertProviderSplitCatalogDisjoint,
  classifyProviderSplitModel,
  type ProviderSplitCatalog,
  type ProviderSplitDecision,
} from "./providers/split-map";

const DEFAULT_MAX_BODY_BYTES = MAX_DECOMPRESSED_BODY_BYTES;
const SPLIT_BRIDGE_IDLE_TIMEOUT_SECONDS = 255;
const HEALTH_PATH = "/healthz";
const CAPABILITIES_PATH = "/capabilities";
const RESPONSE_PATHS = new Set(["/v1/responses", "/v1/responses/compact"]);
const REQUEST_METADATA_HEADERS = [
  "content-type",
  "accept",
  "x-request-id",
  "x-client-request-id",
  "openai-request-id",
];

// Deliberately independent from the general adapter list. Adding a header to another
// provider's forwarding contract must not silently widen this bridge's native boundary.
const OFFICIAL_SPLIT_FORWARD_HEADERS = [
  "authorization",
  "chatgpt-account-id",
  "openai-beta",
  "originator",
  "session_id",
  "session-id",
  "thread-id",
  "x-client-request-id",
  "x-codex-beta-features",
  "x-codex-installation-id",
  "x-codex-parent-thread-id",
  "x-codex-turn-metadata",
  "x-codex-turn-state",
  "x-codex-window-id",
  "x-oai-attestation",
  "x-openai-subagent",
  "x-responsesapi-include-timing-metrics",
];

const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "retry-after",
  "x-request-id",
  "openai-request-id",
  "ratelimit-limit",
  "ratelimit-remaining",
  "ratelimit-reset",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
]);

export interface SplitBridgeOptions {
  readonly catalog: ProviderSplitCatalog;
  /** Absolute official upstream origin or path prefix. */
  readonly nativeBaseUrl: string;
  /** Absolute third-party gateway origin or path prefix. */
  readonly gatewayBaseUrl: string;
  /** Injected in tests; the default is the platform fetch implementation. */
  readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Maximum number of decompressed request-body bytes materialized for model classification. */
  readonly maxBodyBytes?: number;
  /** Secret shared only between the split bridge and the local third-party gateway. */
  readonly gatewayAdmissionToken: string;
  /** Listener port reported by the local health contract. */
  readonly port?: number;
}

export interface StartSplitBridgeOptions extends SplitBridgeOptions {
  readonly hostname?: string;
  readonly port?: number;
}

type SplitBridgeHandler = (request: Request) => Response | Promise<Response>;

function errorResponse(status: number, code: string, message: string): Response {
  const type = status === 426
    ? "upgrade_required"
    : status >= 500
      ? "server_error"
      : "invalid_request_error";
  return new Response(JSON.stringify({
    error: {
      message,
      type,
      code,
    },
  }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function parseBaseUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${name} must be an absolute HTTP(S) URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TypeError(`${name} must be an absolute HTTP(S) URL`);
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new TypeError(`${name} must contain only an HTTP(S) origin and path prefix`);
  }
  return parsed;
}

function physicalOrigin(base: URL): string {
  return base.origin.toLowerCase();
}

const UPSTREAM_ROUTE_SUFFIXES = {
  native: {
    "/v1/responses": "/responses",
    "/v1/responses/compact": "/responses/compact",
  },
  gateway: {
    "/v1/responses": "/responses",
    "/v1/responses/compact": "/responses/compact",
  },
} as const;

type SplitUpstreamChannel = keyof typeof UPSTREAM_ROUTE_SUFFIXES;

/** Resolve an allowlisted endpoint from an explicit native/gateway route table. */
function targetUrl(base: URL, incoming: URL, channel: SplitUpstreamChannel): string {
  const suffix = UPSTREAM_ROUTE_SUFFIXES[channel][incoming.pathname as keyof typeof UPSTREAM_ROUTE_SUFFIXES[SplitUpstreamChannel]];
  if (!suffix) throw new TypeError(`Unsupported split bridge route: ${incoming.pathname}`);
  let basePath = base.pathname.replace(/\/+$/, "");
  // A gateway origin is accepted for convenience, but its contract is still /v1/...;
  // an explicitly supplied path prefix remains authoritative.
  if (channel === "gateway" && (basePath.length === 0 || basePath === "/")) basePath = "/v1";
  const path = `${basePath}/${suffix.replace(/^\/+/, "")}`;
  const target = new URL(path, base.origin);
  target.search = incoming.search;
  return target.toString();
}

export function assertSplitBridgeTargetUrls(nativeBaseUrl: string, gatewayBaseUrl: string): void {
  const nativeBase = parseBaseUrl(nativeBaseUrl, "nativeBaseUrl");
  const gatewayBase = parseBaseUrl(gatewayBaseUrl, "gatewayBaseUrl");
  if (physicalOrigin(nativeBase) === physicalOrigin(gatewayBase)) {
    throw new TypeError("nativeBaseUrl and gatewayBaseUrl must use different physical origins");
  }
}

function requestHeaders(
  incoming: Headers,
  decision: ProviderSplitDecision,
  gatewayAdmissionToken: string,
  requestedModel: string,
): Headers {
  const selected = new Headers();
  const accountGateway = decision.channel === "official-native-account";
  const allowed = decision.channel === "third-party-gateway"
    ? REQUEST_METADATA_HEADERS
    : [...OFFICIAL_SPLIT_FORWARD_HEADERS, ...REQUEST_METADATA_HEADERS]
      .filter(name => !accountGateway || (name !== "authorization" && name !== "chatgpt-account-id"));
  for (const name of allowed) {
    const value = incoming.get(name);
    if (value !== null) selected.set(name, value);
  }
  if (decision.channel === "third-party-gateway" || accountGateway) {
    // Never inherit the incoming value: only the bridge's configured secret can pass.
    selected.set(SPLIT_BRIDGE_ADMISSION_HEADER, gatewayAdmissionToken);
    if (accountGateway) selected.set(SPLIT_BRIDGE_ACCOUNT_SELECTOR_HEADER, requestedModel);
  }
  return selected;
}

function responseHeaders(upstream: Headers): Headers {
  const selected = new Headers();
  for (const [name, value] of upstream) {
    if (SAFE_RESPONSE_HEADERS.has(name.toLowerCase())) selected.set(name, value);
  }
  return selected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isResponsesWebSocketUpgrade(request: Request, path: string): boolean {
  return path === "/v1/responses"
    // Some Bun/Codex handshake paths omit Connection after the request has
    // crossed the local proxy. Upgrade is the decisive signal here; requiring
    // both headers incorrectly falls through to the ordinary 405 method guard.
    && request.headers.get("upgrade")?.trim().toLowerCase() === "websocket";
}

async function readRequestJson(
  request: Request,
  maxBodyBytes: number,
): Promise<{ body: Record<string, unknown>; raw: string } | Response> {
  if (request.signal.aborted) throw request.signal.reason;
  let parsed: unknown;
  try {
    parsed = await readBoundedJsonRequestBody(request, maxBodyBytes, undefined, {
      signal: request.signal,
      fatalUtf8: true,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (error instanceof DecompressedBodyTooLargeError) {
      return errorResponse(413, "request_too_large", "Request body exceeds the configured limit");
    }
    if (error instanceof UnsupportedContentEncodingError) {
      return errorResponse(415, "invalid_request", error.message);
    }
    return errorResponse(400, "invalid_request", "Invalid JSON request body");
  }
  if (!isRecord(parsed)) {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object");
  }
  return { body: parsed, raw: JSON.stringify(parsed) };
}

function canonicalBody(raw: string, body: Record<string, unknown>, decision: ProviderSplitDecision): string {
  if (decision.channel === "official-native-account" || decision.canonicalModel === body.model) return raw;
  // Account-qualified native slugs are catalog identities, not upstream model ids.
  return JSON.stringify({ ...body, model: decision.canonicalModel });
}

/**
 * Build the isolated split data-plane handler. It has no listener or configuration
 * side effects; all network behavior is behind the injected fetch implementation.
 * This bounded slice intentionally covers only HTTP Responses/compact; WebSocket,
 * app-server, Images, search, and lifecycle remain outside this handler. Account-
 * qualified native rows delegate to 10100 so exact credential resolution stays in
 * the existing Responses implementation.
 */
export function createSplitBridgeHandler(options: SplitBridgeOptions): SplitBridgeHandler {
  const nativeBase = parseBaseUrl(options.nativeBaseUrl, "nativeBaseUrl");
  const gatewayBase = parseBaseUrl(options.gatewayBaseUrl, "gatewayBaseUrl");
  if (physicalOrigin(nativeBase) === physicalOrigin(gatewayBase)) {
    throw new TypeError("nativeBaseUrl and gatewayBaseUrl must use different physical origins");
  }
  assertProviderSplitCatalogDisjoint(options.catalog);
  if (typeof options.gatewayAdmissionToken !== "string" || options.gatewayAdmissionToken.trim().length === 0) {
    throw new TypeError("gatewayAdmissionToken must be a non-empty secret");
  }
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("maxBodyBytes must be a positive safe integer");
  }

  return async (request: Request): Promise<Response> => {
    const incoming = new URL(request.url);
    if (incoming.pathname === HEALTH_PATH) {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Only GET is supported for healthz");
      // Liveness only: probing an upstream here would couple the two failure domains.
      return Response.json({
        status: "ok",
        service: "opencodex-split-bridge",
        pid: process.pid,
        port: options.port ?? 10101,
      });
    }
    if (incoming.pathname === CAPABILITIES_PATH) {
      if (request.method !== "GET") return errorResponse(405, "method_not_allowed", "Only GET is supported for capabilities");
      return Response.json({
        status: "ok",
        service: "opencodex-split-bridge",
        transports: {
          responsesHttp: true,
          responsesCompactHttp: true,
          responsesWebSocketFallback: true,
        },
        catalogGeneration: options.catalog.generation,
        gatewayAdmissionConfigured: true,
      });
    }
    if (!RESPONSE_PATHS.has(incoming.pathname)) {
      return errorResponse(404, "not_found", "Split bridge endpoint not found");
    }
    if (isResponsesWebSocketUpgrade(request, incoming.pathname)) {
      return errorResponse(426, "upgrade_required", "Responses WebSocket transport is not supported; use HTTP");
    }
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed", "Only POST is supported for Responses endpoints");
    }

    const parsed = await readRequestJson(request, maxBodyBytes);
    if (parsed instanceof Response) return parsed;

    // There is deliberately one classifier call and no provider-prefix inference here.
    const requestedModel = typeof parsed.body.model === "string" ? parsed.body.model : "";
    const decision = classifyProviderSplitModel(requestedModel, options.catalog);
    if (decision.channel === "invalid" || decision.canonicalModel === null) {
      return errorResponse(400, "unknown_model", "Requested model is not in the split catalog");
    }

    const isGateway = decision.channel === "third-party-gateway" || decision.channel === "official-native-account";
    const target = targetUrl(isGateway ? gatewayBase : nativeBase, incoming, isGateway ? "gateway" : "native");
    const canonical = canonicalBody(parsed.raw, parsed.body, decision);
    const upstreamBody = isGateway
      ? canonical
      : JSON.stringify(normalizeOpenAiResponsesForwardBody(
        decision.canonicalModel === parsed.body.model
          ? parsed.body
          : { ...parsed.body, model: decision.canonicalModel },
        {
          modelId: decision.canonicalModel,
          replayMiss: typeof parsed.body.previous_response_id === "string",
        },
      ));
    try {
      const upstream = await fetchImpl(target, {
        method: "POST",
        headers: requestHeaders(request.headers, decision, options.gatewayAdmissionToken, requestedModel),
        body: upstreamBody,
        signal: request.signal,
      });
      // Do not inspect or buffer upstream.body: this keeps SSE backpressure and cancellation.
      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders(upstream.headers),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      return errorResponse(
        isGateway ? 503 : 502,
        isGateway ? "gateway_unavailable" : "native_upstream_unavailable",
        isGateway ? "Third-party gateway unavailable" : "Native upstream unavailable",
      );
    }
  };
}

/** Start the isolated listener; wiring and lifecycle ownership remain outside this slice. */
export function startSplitBridge(options: StartSplitBridgeOptions): Server<undefined> {
  const handler = createSplitBridgeHandler(options);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 10101,
    idleTimeout: SPLIT_BRIDGE_IDLE_TIMEOUT_SECONDS,
    maxRequestBodySize: maxBodyBytes,
    fetch: handler,
  });
}
