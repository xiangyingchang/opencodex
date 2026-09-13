import { describe, expect, test } from "bun:test";
import { createSplitBridgeHandler, startSplitBridge, type SplitBridgeOptions } from "../src/split-bridge";
import type { ProviderSplitCatalog } from "../src/providers/split-map";

const catalog: ProviderSplitCatalog = {
  generation: "catalog-test-1",
  officialModels: new Set(["gpt-5.6-luna", "gpt-5.5"]),
  officialAccountSlugs: new Set(["side/gpt-5.5"]),
  officialAccountNamespaces: new Set(["side"]),
  officialAccountModels: new Set(["gpt-5.5"]),
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
        controller.enqueue(new TextEncoder().encode(
          `event: response.completed
data: {"type":"response.completed"}

`,
        ));
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
    expect(calls[0]?.url).toBe("https://native.example/responses?stream=true");
    expect((calls[0]?.init?.headers as Headers).get("accept-encoding")).toBe("identity");
    expect((calls[0]?.init?.headers as Headers).has("x-opencodex-bridge-admission")).toBe(false);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("retry-after")).toBe("2");
    expect(response.headers.get("x-request-id")).toBe("req-native");
    expect(response.headers.get("openai-request-id")).toBe("openai-native");
    expect(response.headers.get("x-ratelimit-remaining-tokens")).toBe("42");
    expect(response.headers.has("x-upstream-secret")).toBe(false);
    expect(await response.text()).toContain("response.completed");
  });

  test("delegates exact account models through the gateway and keeps API-key models on gateway policy", async () => {
    const requests: string[] = [];
    const { handler, calls } = makeBridge(async (input, init) => {
      requests.push(await new Request(input, init).text());
      return jsonResponse({ ok: true });
    });

    await handler(postRequest("side/gpt-5.5"));
    await handler(postRequest("openai-apikey/gpt-5.6-luna"));

    expect(calls.map(call => call.url)).toEqual([
      "http://gateway.example/v1/responses",
      "http://gateway.example/v1/responses",
    ]);
    expect(JSON.parse(requests[0] ?? "{}")).toMatchObject({ model: "side/gpt-5.5" });
    expect(JSON.parse(requests[1] ?? "{}")).toMatchObject({ model: "openai-apikey/gpt-5.6-luna" });
    const accountHeaders = calls[0]?.init?.headers as Headers;
    expect(accountHeaders.get("x-opencodex-bridge-admission")).toBe("test-gateway-admission");
    expect(accountHeaders.get("x-opencodex-bridge-account-selector")).toBe("side/gpt-5.5");
    expect(accountHeaders.has("authorization")).toBe(false);
    expect(accountHeaders.has("chatgpt-account-id")).toBe(false);
  });

  test("maps the canonical native base and compact route without leaking the inbound /v1 prefix", async () => {
    const { handler, calls } = makeBridge(async () => jsonResponse({ ok: true }), {
      nativeBaseUrl: "https://chatgpt.example/backend-api/codex/",
    });

    await handler(postRequest("gpt-5.6-luna", "/v1/responses?stream=true&turn=2"));
    await handler(postRequest("gpt-5.6-luna", "/v1/responses/compact?source=codex"));

    expect(calls.map(call => call.url)).toEqual([
      "https://chatgpt.example/backend-api/codex/responses?stream=true&turn=2",
      "https://chatgpt.example/backend-api/codex/responses/compact?source=codex",
    ]);
  });

  test("reuses forward normalization for native bodies but leaves gateway bodies untouched", async () => {
    const oversizedCallId = "call_" + "x".repeat(80);
    const { handler, calls } = makeBridge(async () => jsonResponse({ ok: true }));

    await handler(postRequest("gpt-5.6-luna", "/v1/responses", {}, {
      previous_response_id: "resp-native",
      metadata: { source: "client" },
      max_output_tokens: 32000,
      input: [
        { type: "reasoning", encrypted_content: "ocxr1:proxy-envelope", content: [{ type: "reasoning_text", text: "private" }] },
        { type: "compaction", encrypted_content: `ocx1:${Buffer.from("summary").toString("base64")}` },
        { type: "function_call", call_id: oversizedCallId, name: "ping", arguments: "{}" },
        { type: "function_call_output", call_id: oversizedCallId, output: "pong" },
      ],
    }));
    await handler(postRequest("deepseek/deepseek-v4-flash", "/v1/responses", {}, {
      previous_response_id: "resp-gateway",
      metadata: { source: "client" },
      max_output_tokens: 32000,
    }));

    const nativeBody = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(nativeBody).not.toHaveProperty("previous_response_id");
    expect(nativeBody).not.toHaveProperty("metadata");
    expect(nativeBody).not.toHaveProperty("max_output_tokens");
    const nativeInput = nativeBody.input as Record<string, unknown>[];
    expect(nativeInput.some(item => item.type === "reasoning")).toBe(false);
    expect(nativeInput.some(item => item.type === "message" && JSON.stringify(item).includes("summary"))).toBe(true);
    const nativeCall = nativeInput.find(item => item.type === "function_call");
    const nativeOutput = nativeInput.find(item => item.type === "function_call_output");
    expect(nativeCall?.call_id).toBe(nativeOutput?.call_id);
    expect(String(nativeCall?.call_id).length).toBeLessThanOrEqual(64);

    const gatewayBody = JSON.parse(String(calls[1]?.init?.body)) as Record<string, unknown>;
    expect(gatewayBody.previous_response_id).toBe("resp-gateway");
    expect(gatewayBody.metadata).toEqual({ source: "client" });
    expect(gatewayBody.max_output_tokens).toBe(32000);
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

  test("decodes Codex zstd-compressed HTTP fallback bodies before classification", async () => {
    const requests: string[] = [];
    const { handler, calls } = makeBridge(async (input, init) => {
      requests.push(await new Request(input, init).text());
      return jsonResponse({ ok: true });
    });
    const body = JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello", stream: true });

    const response = await handler(new Request("http://127.0.0.1:10101/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-encoding": "zstd",
      },
      body: Bun.zstdCompressSync(new TextEncoder().encode(body)),
    }));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(requests[0] ?? "{}")).toEqual(JSON.parse(body));
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

  test("retries a native pre-stream ECONNRESET on a fresh connection without retrying the gateway", async () => {
    let nativeAttempts = 0;
    const native = makeBridge(async () => {
      nativeAttempts++;
      if (nativeAttempts === 1) {
        throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
      }
      return jsonResponse({ ok: true });
    });

    const nativeResponse = await native.handler(postRequest("gpt-5.6-luna"));

    expect(nativeResponse.status).toBe(200);
    expect(await nativeResponse.json()).toEqual({ ok: true });
    expect(native.calls).toHaveLength(2);
    const firstInit = native.calls[0]?.init;
    const recoveryInit = native.calls[1]?.init;
    expect((recoveryInit?.headers as Headers).get("connection")).toBe("close");
    expect(recoveryInit?.keepalive).toBe(false);
    expect(recoveryInit?.signal).toBe(firstInit?.signal);
    expect(recoveryInit?.body).toBe(firstInit?.body);

    const gateway = makeBridge(async () => {
      throw Object.assign(new Error("gateway socket reset"), { code: "ECONNRESET" });
    });
    const gatewayResponse = await gateway.handler(postRequest("deepseek/deepseek-v4-flash"));

    expect(gatewayResponse.status).toBe(503);
    expect(await errorCode(gatewayResponse)).toBe("gateway_unavailable");
    expect(gateway.calls).toHaveLength(1);
  });

  test("requests identity encoding for native SSE and converts a mid-stream body error to a failed tail", async () => {
    const encoder = new TextEncoder();
    const sensitiveUpstreamError = "fetch https://native.example/responses?token=not-for-client body=private";
    const { handler, calls } = makeBridge(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.created\ndata: {"type":"response.created"}\n\n`,
          ));
          queueMicrotask(() => controller.error(Object.assign(
            new Error(sensitiveUpstreamError),
            { code: "ECONNRESET" },
          )));
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
          "content-length": "999",
        },
      },
    ));

    const response = await handler(postRequest("gpt-5.6-luna", "/v1/responses", {}, { stream: true }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((calls[0]?.init?.headers as Headers).get("accept-encoding")).toBe("identity");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(text).toContain('"type":"response.failed"');
    expect(text).toContain('"code":"upstream_reset"');
    expect(text).not.toContain(sensitiveUpstreamError);
    expect(text).toContain(`data: [DONE]\n\n`);

    const health = await handler(new Request("http://127.0.0.1:10101/healthz"));
    const healthBody = await health.json() as { admission?: { native?: { active?: number } } };
    expect(healthBody.admission?.native?.active).toBe(0);
  });

  test("converts native SSE clean EOF without a terminal to a failed tail and releases admission", async () => {
    const encoder = new TextEncoder();
    const { handler } = makeBridge(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.created
data: {"type":"response.created"}

`,
          ));
          controller.close();
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const response = await handler(postRequest("gpt-5.6-luna", "/v1/responses", {}, { stream: true }));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain('"type":"response.failed"');
    expect(text).toContain('"code":"upstream_eof"');
    expect(text.endsWith(`data: [DONE]

`)).toBe(true);

    const health = await handler(new Request("http://127.0.0.1:10101/healthz"));
    const healthBody = await health.json() as { admission?: { native?: { active?: number } } };
    expect(healthBody.admission?.native?.active).toBe(0);
  });

  test("aborts the split native upstream controller after a protocol terminal", async () => {
    const encoder = new TextEncoder();
    const { handler, calls } = makeBridge(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(
            `event: response.completed
data: {"type":"response.completed"}

`,
          ));
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    ));

    const response = await handler(postRequest("gpt-5.6-luna", "/v1/responses", {}, { stream: true }));
    expect(await response.text()).toContain("response.completed");
    expect((calls[0]?.init?.signal as AbortSignal).aborted).toBe(true);
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
    const body = await response.json() as { status?: string; service?: string; port?: number; pid?: number };
    expect(body).toMatchObject({ status: "ok", service: "opencodex-split-bridge", port: 10101 });
    expect(typeof body.pid).toBe("number");
    expect(calls).toHaveLength(0);
  });

  test("serves static transport capabilities without consulting either upstream", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    const response = await handler(new Request("http://127.0.0.1:10101/capabilities"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      service: "opencodex-split-bridge",
      transports: {
        responsesHttp: true,
        responsesCompactHttp: true,
        responsesWebSocketFallback: true,
        imagesHttp: true,
        searchHttp: true,
      },
      gatewayAdmissionConfigured: true,
    });
    expect(calls).toHaveLength(0);
  });

  test("routes standalone image generation and edits to the gateway without model classification", async () => {
    const requests: { url: string; body: unknown; headers: Headers }[] = [];
    const { handler, calls } = makeBridge(async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json(), headers: request.headers });
      return jsonResponse({ created: 1, data: [{ b64_json: "aGVsbG8=" }] });
    });
    const headers = {
      authorization: "Bearer caller-credential",
      "chatgpt-account-id": "caller-account",
      "x-request-id": "image-request",
    };

    const generations = await handler(new Request("http://127.0.0.1:10101/v1/images/generations", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ prompt: "a cat", model: "gpt-image-2" }),
    }));
    const edits = await handler(new Request("http://127.0.0.1:10101/v1/images/edits", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ prompt: "add gold ink", images: [{ image_url: "data:image/png;base64,aGk=" }] }),
    }));

    expect(generations.status).toBe(200);
    expect(edits.status).toBe(200);
    expect(calls.map(call => call.url)).toEqual([
      "http://gateway.example/v1/images/generations",
      "http://gateway.example/v1/images/edits",
    ]);
    expect(requests.map(request => new URL(request.url).pathname)).toEqual([
      "/v1/images/generations",
      "/v1/images/edits",
    ]);
    expect(requests[0]?.body).toEqual({ prompt: "a cat", model: "gpt-image-2" });
    expect(requests[1]?.body).toMatchObject({ prompt: "add gold ink" });
    const forwarded = requests[0]?.headers;
    expect(forwarded?.get("x-opencodex-bridge-admission")).toBe("test-gateway-admission");
    expect(forwarded?.get("x-request-id")).toBe("image-request");
    expect(forwarded?.has("authorization")).toBe(false);
    expect(forwarded?.has("chatgpt-account-id")).toBe(false);
  });

  test("routes hosted search to the gateway with official auth context and bridge admission", async () => {
    const requests: { url: string; body: unknown; headers: Headers }[] = [];
    const { handler, calls } = makeBridge(async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, body: await request.json(), headers: request.headers });
      return jsonResponse({ results: [{ title: "official result" }] });
    });

    const response = await handler(postRequest("unknown/model", "/v1/alpha/search?source=codex", {
      authorization: "Bearer chatgpt-credential",
      "chatgpt-account-id": "acct-search",
      session_id: "session-search",
      "x-codex-turn-metadata": "turn-search",
      "x-request-id": "search-request",
      "x-opencodex-bridge-admission": "forged-by-client",
      "x-custom": "must-not-forward",
    }, {
      query: "kangaroo sanctuary",
    }));

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://gateway.example/v1/alpha/search?source=codex");
    expect(requests[0]?.body).toEqual({ model: "unknown/model", query: "kangaroo sanctuary" });
    const forwarded = requests[0]?.headers;
    expect(forwarded?.get("authorization")).toBe("Bearer chatgpt-credential");
    expect(forwarded?.get("chatgpt-account-id")).toBe("acct-search");
    expect(forwarded?.get("session_id")).toBe("session-search");
    expect(forwarded?.get("x-codex-turn-metadata")).toBe("turn-search");
    expect(forwarded?.get("x-request-id")).toBe("search-request");
    expect(forwarded?.get("x-opencodex-bridge-admission")).toBe("test-gateway-admission");
    expect(forwarded?.has("x-custom")).toBe(false);
  });

  test("rejects a Responses WebSocket upgrade with 426 without calling upstream", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    const response = await handler(new Request("http://127.0.0.1:10101/v1/responses", {
      method: "GET",
      headers: { connection: "Upgrade", upgrade: "websocket" },
    }));

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      error: { type: "upgrade_required", code: "upgrade_required" },
    });
    expect(calls).toHaveLength(0);
  });

  test("recognizes a WebSocket upgrade when Connection is absent", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    const response = await handler(new Request("http://127.0.0.1:10101/v1/responses", {
      method: "GET",
      headers: { upgrade: "websocket" },
    }));

    expect(response.status).toBe(426);
    expect(await response.json()).toMatchObject({
      error: { type: "upgrade_required", code: "upgrade_required" },
    });
    expect(calls).toHaveLength(0);
  });

  test("keeps the handler usable for HTTP POST after a rejected upgrade", async () => {
    const { handler, calls } = makeBridge(async () => jsonResponse({ ok: "http-fallback" }));

    const upgrade = await handler(new Request("http://127.0.0.1:10101/v1/responses", {
      method: "GET",
      headers: { connection: "Upgrade", upgrade: "websocket" },
    }));
    const post = await handler(postRequest("gpt-5.6-luna"));

    expect(upgrade.status).toBe(426);
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ ok: "http-fallback" });
    expect(calls).toHaveLength(1);
  });

  test("starts independently on an ephemeral port without consulting the gateway", async () => {
    const server = startSplitBridge({
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://127.0.0.1:10100/v1",
      gatewayAdmissionToken: "[REDACTED]",
      port: 0,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/healthz`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: "ok", service: "opencodex-split-bridge", port: 0 });
    } finally {
      server.stop();
    }
  });

  test("does not forward unsupported paths or methods", async () => {
    const { handler, calls } = makeBridge(async () => {
      throw new Error("must not be called");
    });

    expect((await handler(new Request("http://127.0.0.1:10101/v1/models"))).status).toBe(404);
    expect((await handler(new Request("http://127.0.0.1:10101/v1/responses"))).status).toBe(405);
    expect((await handler(new Request("http://127.0.0.1:10101/v1/images/generations"))).status).toBe(405);
    expect((await handler(new Request("http://127.0.0.1:10101/v1/alpha/search"))).status).toBe(405);
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
