import type { Server } from "bun";
import { readBoundedResponseBody } from "./lib/bounded-body";
import {
  assertProviderSplitCatalogDisjoint,
  classifyProviderSplitModel,
  type ProviderSplitCatalog,
  type ProviderSplitDecision,
} from "./providers/split-map";

const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const HEALTH_PATH = "/healthz";
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

const GATEWAY_ADMISSION_HEADER = "x-opencodex-bridge-admission";

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
  /** Maximum number of request-body bytes materialized for model classification. */
  readonly maxBodyBytes?: number;
  /** Secret shared only between the split bridge and the local third-party gateway. */
  readonly gatewayAdmissionToken: string;
}

export interface StartSplitBridgeOptions extends SplitBridgeOptions {
  readonly hostname?: string;
  readonly port?: number;
}

type SplitBridgeHandler = (request: Request) => Response | Promise<Response>;

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({
    error: {
      message,
      type: status >= 500 ? "server_error" : "invalid_request_error",
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

/**
 * Resolve the target from the selected base only. The incoming query is retained;
 * a base path is treated as a prefix unless the incoming path already contains it.
 * This supports both `https://host` and `http://127.0.0.1:10100/v1` inputs without
 * allowing the caller-controlled URL to select another origin.
 */
function targetUrl(base: URL, incoming: URL): string {
  const basePath = base.pathname.replace(/\/+$/, "");
  const incomingPath = incoming.pathname.startsWith("/") ? incoming.pathname : `/${incoming.pathname}`;
  const path =
    basePath.length === 0 || basePath === "/" || incomingPath === basePath || incomingPath.startsWith(`${basePath}/`)
      ? incomingPath
      : `${basePath}/${incomingPath.replace(/^\/+/, "")}`;
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

function requestHeaders(incoming: Headers, decision: ProviderSplitDecision, gatewayAdmissionToken: string): Headers {
  const selected = new Headers();
  const allowed = decision.channel === "third-party-gateway"
    ? REQUEST_METADATA_HEADERS
    : [...OFFICIAL_SPLIT_FORWARD_HEADERS, ...REQUEST_METADATA_HEADERS];
  for (const name of allowed) {
    const value = incoming.get(name);
    if (value !== null) selected.set(name, value);
  }
  if (decision.channel === "third-party-gateway") {
    // Never inherit the incoming value: only the bridge's configured secret can pass.
    selected.set(GATEWAY_ADMISSION_HEADER, gatewayAdmissionToken);
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

async function readRequestJson(
  request: Request,
  maxBodyBytes: number,
): Promise<{ body: Record<string, unknown>; raw: string } | Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    return errorResponse(413, "request_too_large", "Request body exceeds the configured limit");
  }

  let bounded;
  try {
    bounded = await readBoundedResponseBody(new Response(request.body), {
      maxBytes: maxBodyBytes,
      fatalUtf8: true,
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    return errorResponse(400, "invalid_request", "Invalid JSON request body");
  }
  if (bounded.oversized) {
    return errorResponse(413, "request_too_large", "Request body exceeds the configured limit");
  }
  if (bounded.truncated || !bounded.displaySafe) {
    return errorResponse(400, "invalid_request", "Invalid JSON request body");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bounded.text);
  } catch {
    return errorResponse(400, "invalid_request", "Invalid JSON request body");
  }
  if (!isRecord(parsed)) {
    return errorResponse(400, "invalid_request", "Request body must be a JSON object");
  }
  return { body: parsed, raw: bounded.text };
}

function canonicalBody(raw: string, body: Record<string, unknown>, decision: ProviderSplitDecision): string {
  if (decision.canonicalModel === body.model) return raw;
  // Account-qualified native slugs are catalog identities, not upstream model ids.
  return JSON.stringify({ ...body, model: decision.canonicalModel });
}

/**
 * Build the isolated split data-plane handler. It has no listener or configuration
 * side effects; all network behavior is behind the injected fetch implementation.
 * This bounded slice intentionally covers only HTTP Responses/compact; WebSocket,
 * app-server, Images, search, lifecycle, and admission wiring remain future work.
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
      return Response.json({ status: "ok", service: "opencodex-split-bridge" });
    }
    if (!RESPONSE_PATHS.has(incoming.pathname)) {
      return errorResponse(404, "not_found", "Split bridge endpoint not found");
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

    const isGateway = decision.channel === "third-party-gateway";
    const target = targetUrl(isGateway ? gatewayBase : nativeBase, incoming);
    try {
      const upstream = await fetchImpl(target, {
        method: "POST",
        headers: requestHeaders(request.headers, decision, options.gatewayAdmissionToken),
        body: canonicalBody(parsed.raw, parsed.body, decision),
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
  return Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port ?? 10101,
    fetch: handler,
  });
}
