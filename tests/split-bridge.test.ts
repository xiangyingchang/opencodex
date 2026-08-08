import { describe, expect, test } from "bun:test";
import { createSplitBridgeHandler, type SplitBridgeOptions } from "../src/split-bridge";
import type { ProviderSplitCatalog } from "../src/providers/split-map";

const catalog: ProviderSplitCatalog = {
  generation: "catalog-test-1",
  officialModels: new Set(["gpt-5.6-luna", "gpt-5.5"]),
  officialAccountNamespaces: new Set(["side"]),
  officialApiKeyModels: new Set(["openai-apikey/gpt-5.6-luna"]),
  thirdPartyModels: new Set(["deepseek/deepseek-v4-flash"]),
};

type FetchCall = {
  url: string;
  init: RequestInit | undefined;
};

function makeBridge(
  fetchImpl: NonNullable<SplitBridgeOptions["fetch"]>,
  overrides: Partial<SplitBridgeOptions> = {},
): { handler: ReturnType<typeof createSplitBridgeHandler>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const options: SplitBridgeOptions = {
    catalog,
    nativeBaseUrl: "https://native.example",
    gatewayBaseUrl: "http://gateway.example/v1",
    gatewayAdmissionToken: "test-gateway-admission",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return fetchImpl(input, init);
    },
    ...overrides,
  };
  return { handler: createSplitBridgeHandler(options), calls };
}

function postRequest(
  model: string,
  path = "/v1/responses",
  headers: Record<string, string> = {},
  bodyOverrides: Record<string, unknown> = {},
): Request {
  return new Request(`http://127.0.0.1:10101${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, ...bodyOverrides }),
  });
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function errorCode(response: Response): Promise<string | null> {
  const payload = await response.json() as { error?: { code?: string | null } };
  return payload.error?.code ?? null;
}

describe("Provider Split Bridge", () => {
  test("routes native requests to nativeBaseUrl and keeps the gateway untouched", async () => {
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: native\n\n"));
        controller.close();
      },
    });
    const upstream = new Response(upstreamBody, {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "retry-after": "2",
        "x-request-id": "req-native",
        "openai-request-id": "openai-native",
        "x-ratelimit-remaining-tokens": "42",
        "x-upstream-secret": "must-not-leak",
      },
    });
    const { handler, calls } = makeBridge(async () => upstream);

    const response = await handler(postRequest("gpt-5.6-luna", "/v1/responses?stream=true"));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://native.example/v1/responses?stream=true");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-request-id")).toBe("req-native");
    expect(response.headers.get("openai-request-id")).toBe("openai-native");
    expect(response.headers.get("x-ratelimit-remaining-tokens")).toBe("42");
    expect(response.headers.has("x-upstream-secret")).toBe(false);
    expect(await response.text()).toBe("data: native\n\n");
  });

  test("routes official account and API-key models to the native channel", async () => {
    const requests: string[] = [];
    const { handler, calls } = makeBridge(async (input, init) => {
      requests.push(await new Request(input, init).text());
      return jsonResponse({ ok: true });
    });

    await handler(postRequest("side/gpt-5.5"));
    await handler(postRequest("openai-apikey/gpt-5.6-luna"));

    expect(calls.map(call => call.url)).toEqual([
      "https://native.example/v1/responses",
      "https://native.example/v1/responses",
    ]);
    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({ model: "gpt-5.5" });
    expect(JSON.parse(requests[1] ?? "{}")).toMatchObject({ model: "openai-apikey/gpt-5.6-luna" });
  });

  test("forwards the native Codex allowlist but preserves request metadata", async () => {
    const { handler, calls } = makeBridge(async () => jsonResponse({ ok: true }));

    await handler(postRequest("gpt-5.6-luna", "/v1/responses", {
      authorization: "Bearer native-secret",
      "chatgpt-account-id": "acct-native",
      "openai-beta": "responses=1",
      "x-codex-turn-metadata": "turn-meta",
      "x-oai-attestation": "attestation",
      "content-type": "application/json; charset=utf-8",
      accept: "text/event-stream",
      "x-request-id": "request-1",
      "x-client-request-id": "client-request-1",
      "openai-request-id": "openai-request-1",
    }));

    const forwarded = calls[0]?.init?.headers as Headers;
    expect(forwarded.get("authorization")).toBe("Bearer native-secret");
    expect(forwarded.get("chatgpt-account-id")).toBe("acct-native");
    expect(forwarded.get("openai-beta")).toBe("responses=1");
    expect(forwarded.get("x-codex-turn-metadata")).toBe("turn-meta");
    expect(forwarded.get("x-oai-attestation")).toBe("attestation");
    expect(forwarded.get("content-type")).toBe("application/json; charset=utf-8");
    expect(forwarded.get("accept")).toBe("text/event-stream");
    expect(forwarded.get("x-request-id")).toBe("request-1");
    expect(forwarded.get("x-client-request-id")).toBe("client-request-1");
    expect(forwarded.get("openai-request-id")).toBe("openai-request-1");
  });

  test("routes third-party requests only to gatewayBaseUrl and strips native credentials", async () => {
    const { handler, calls } = makeBridge(async () => jsonResponse({ ok: true }));

    await handler(postRequest("deepseek/deepseek-v4-flash", "/v1/responses/compact", {
      authorization: "Bearer native-secret",
      "chatgpt-account-id": "acct-native",
      "x-oai-attestation": "attestation",
      "x-codex-turn-metadata": "turn-meta",
      "x-codex-parent-thread-id": "thread-id",
      "openai-beta": "responses=1",
      "x-custom": "must-not-forward",
      "x-opencodex-bridge-admission": "forged-by-client",
      accept: "text/event-stream",
      "x-request-id": "request-2",
      "x-client-request-id": "client-request-2",
      "openai-request-id": "openai-request-2",
    }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://gateway.example/v1/responses/compact");
    const forwarded = calls[0]?.init?.headers as Headers;
    expect(forwarded.get("content-type")).toBe("application/json");
    expect(forwarded.get("accept")).toBe("text/event-stream");
    expect(forwarded.get("x-request-id")).toBe("request-2");
    expect(forwarded.get("x-client-request-id")).toBe("client-request-2");
    expect(forwarded.get("openai-request-id")).toBe("openai-request-2");
    expect(forwarded.get("x-opencodex-bridge-admission")).toBe("test-gateway-admission");
    for (const name of [
      "authorization",
      "chatgpt-account-id",
      "x-oai-attestation",
      "x-codex-turn-metadata",
      "x-codex-parent-thread-id",
      "openai-beta",
      "x-custom",
    ]) {
      expect(forwarded.has(name)).toBe(false);
    }
  });

  test("returns a deterministic unknown_model 400 without calling either upstream", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    const response = await handler(postRequest("unknown/model"));

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("unknown_model");
    expect(calls).toHaveLength(0);
  });

  test("maps native and gateway fetch failures without cross-channel fallback", async () => {
    const native = makeBridge(async () => { throw new Error("native down"); });
    const nativeResponse = await native.handler(postRequest("gpt-5.6-luna"));
    expect(nativeResponse.status).toBe(502);
    expect(await errorCode(nativeResponse)).toBe("native_upstream_unavailable");
    expect(native.calls).toHaveLength(1);

    const gateway = makeBridge(async () => { throw new Error("gateway down"); });
    const gatewayResponse = await gateway.handler(postRequest("deepseek/deepseek-v4-flash"));
    expect(gatewayResponse.status).toBe(503);
    expect(await errorCode(gatewayResponse)).toBe("gateway_unavailable");
    expect(gateway.calls).toHaveLength(1);
  });

  test("rejects a body that exceeds the configured bound before classification or fetch", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    }, { maxBodyBytes: 32 });

    const response = await handler(postRequest("gpt-5.6-luna", "/v1/responses", {}, {
      input: [{ type: "message", content: "this body is intentionally larger than the bound" }],
    }));

    expect(response.status).toBe(413);
    expect(await errorCode(response)).toBe("request_too_large");
    expect(calls).toHaveLength(0);
  });

  test("serves local health without consulting either upstream", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    const response = await handler(new Request("http://127.0.0.1:10101/healthz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(calls).toHaveLength(0);
  });

  test("does not forward unsupported paths or methods", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    expect((await handler(new Request("http://127.0.0.1:10101/v1/models"))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1:10101/v1/responses"))).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  test("rejects shared physical origins, base query/fragment, and overlapping catalog claims", () => {
    const base: SplitBridgeOptions = {
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://gateway.example/v1",
      gatewayAdmissionToken: "test-gateway-admission",
    };
    expect(() => createSplitBridgeHandler({
      ...base,
      nativeBaseUrl: "https://same.example/native",
      gatewayBaseUrl: "https://same.example/gateway",
    })).toThrow("different physical origins");
    expect(() => createSplitBridgeHandler({
      ...base,
      nativeBaseUrl: "https://native.example/v1?tenant=one",
    })).toThrow("origin and path prefix");
    expect(() => createSplitBridgeHandler({
      ...base,
      catalog: {
        ...catalog,
        thirdPartyModels: new Set([...catalog.thirdPartyModels, "gpt-5.6-luna"]),
      },
    })).toThrow("catalog overlap");
  });

  test("preserves a client abort while reading the request body", async () => {
    const controller = new AbortController();
    const reason = new DOMException("client closed", "AbortError");
    controller.abort(reason);
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });
    const request = new Request("http://127.0.0.1:10101/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
      signal: controller.signal,
    });
    let caught: unknown;
    try {
      await handler(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  test("preserves a client abort while connecting to an upstream", async () => {
    const controller = new AbortController();
    const reason = new DOMException("client closed", "AbortError");
    const handler = createSplitBridgeHandler({
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://gateway.example/v1",
      gatewayAdmissionToken: "test-gateway-admission",
      fetch: async () => {
        controller.abort(reason);
        throw reason;
      },
    });
    const request = new Request("http://127.0.0.1:10101/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna" }),
      signal: controller.signal,
    });
    let caught: unknown;
    try {
      await handler(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(reason);
  });
});
