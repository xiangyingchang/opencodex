import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSplitBridgeHandler } from "../src/split-bridge";
import {
  hasSplitBridgeAdmission,
  SPLIT_BRIDGE_ACCOUNT_SELECTOR_HEADER,
  SPLIT_BRIDGE_ADMISSION_HEADER,
  splitBridgeTrafficBranch,
} from "../src/server/bridge-admission";
import {
  createSplitAdmissionGates,
  DEFAULT_SPLIT_GATEWAY_MAX_ACTIVE_TURNS,
  DEFAULT_SPLIT_NATIVE_MAX_ACTIVE_TURNS,
  splitAdmissionBranchForChannel,
} from "../src/server/split-admission";
import type { ProviderSplitCatalog } from "../src/providers/split-map";

const catalog: ProviderSplitCatalog = {
  generation: "split-admission-test-1",
  officialModels: new Set(["gpt-5.6-luna"]),
  officialAccountSlugs: new Set(["team/gpt-5.6-luna"]),
  officialAccountNamespaces: new Set(["team"]),
  officialAccountModels: new Set(["gpt-5.6-luna"]),
  officialApiKeyModels: new Set(["openai-apikey/gpt-5.6-luna"]),
  thirdPartyModels: new Set(["deepseek/deepseek-v4-flash"]),
};

function postRequest(model: string, headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:10101/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, input: "hello", stream: true }),
  });
}

async function cancelResponse(response: Response): Promise<void> {
  if (response.body) await response.body.cancel("test cleanup");
}

describe("split admission isolation", () => {
  test("maps logical native/account traffic separately from gateway traffic", () => {
    expect(splitAdmissionBranchForChannel("official-native")).toBe("native");
    expect(splitAdmissionBranchForChannel("official-native-account")).toBe("native");
    expect(splitAdmissionBranchForChannel("third-party-gateway")).toBe("gateway");
    expect(splitAdmissionBranchForChannel("official-api-key")).toBe("gateway");
    expect(splitAdmissionBranchForChannel("invalid")).toBeNull();
  });

  test("keeps native and gateway gate capacity independent and releases exactly once", () => {
    const gates = createSplitAdmissionGates({ native: 1, gateway: 1 });
    const native = gates.native.tryAcquire();
    const gateway = gates.gateway.tryAcquire();
    expect(native).not.toBeNull();
    expect(gateway).not.toBeNull();
    expect(gates.native.tryAcquire()).toBeNull();
    expect(gates.gateway.tryAcquire()).toBeNull();

    native!.release();
    native!.release();
    expect(gates.native.tryAcquire()).not.toBeNull();
    expect(gates.native.metrics()).toMatchObject({ active: 1, admitted: 2, rejected: 1, peak: 1 });
    expect(gates.gateway.metrics()).toMatchObject({ active: 1, admitted: 1, rejected: 1, peak: 1 });

    gateway!.release();
    expect(gates.gateway.metrics().active).toBe(0);
  });

  test("uses bounded production defaults and rejects invalid overrides", () => {
    expect(DEFAULT_SPLIT_NATIVE_MAX_ACTIVE_TURNS).toBe(128);
    expect(DEFAULT_SPLIT_GATEWAY_MAX_ACTIVE_TURNS).toBe(128);
    expect(() => createSplitAdmissionGates({ native: 0 })).toThrow(/positive/);
    expect(() => createSplitAdmissionGates({ gateway: -1 })).toThrow(/positive/);
    expect(() => createSplitAdmissionGates({ native: Number.MAX_SAFE_INTEGER + 1 })).toThrow(/positive/);
  });

  test("keeps a long native stream from consuming gateway capacity", async () => {
    let upstreamCalls = 0;
    const handler = createSplitBridgeHandler({
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://gateway.example/v1",
      gatewayAdmissionToken: "bridge-secret",
      nativeMaxActive: 1,
      gatewayMaxActive: 1,
      fetch: async () => {
        upstreamCalls += 1;
        return new Response(new ReadableStream<Uint8Array>({
          start() {
            // Deliberately stays open until the client cancels the response.
          },
        }), { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });

    const native = await handler(postRequest("gpt-5.6-luna"));
    expect(native.status).toBe(200);
    expect((await handler(postRequest("gpt-5.6-luna"))).status).toBe(503);

    const gateway = await handler(postRequest("deepseek/deepseek-v4-flash"));
    expect(gateway.status).toBe(200);
    expect((await handler(postRequest("deepseek/deepseek-v4-flash"))).status).toBe(503);
    expect(upstreamCalls).toBe(2);

    await cancelResponse(native);
    await cancelResponse(gateway);
    const nativeAfterCancel = await handler(postRequest("gpt-5.6-luna"));
    expect(nativeAfterCancel.status).toBe(200);
    await cancelResponse(nativeAfterCancel);
  });

  test("does not release a lease before EOF and exposes only non-sensitive metrics", async () => {
    const handler = createSplitBridgeHandler({
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://gateway.example/v1",
      gatewayAdmissionToken: "bridge-secret",
      nativeMaxActive: 1,
      gatewayMaxActive: 1,
      fetch: async () => new Response("done", {
        status: 200,
        headers: { "content-type": "text/plain", authorization: "must-not-leak" },
      }),
    });

    const first = await handler(postRequest("gpt-5.6-luna"));
    expect((await handler(postRequest("gpt-5.6-luna"))).status).toBe(503);
    expect(first.headers.has("authorization")).toBe(false);
    expect(await first.text()).toBe("done");
    const third = await handler(postRequest("gpt-5.6-luna"));
    expect(third.status).toBe(200);
    expect(await third.text()).toBe("done");

    const health = await handler(new Request("http://127.0.0.1:10101/healthz"));
    const body = await health.json() as { admission?: { native?: { active?: number; admitted?: number; rejected?: number } } };
    expect(body.admission?.native).toMatchObject({ active: 0, admitted: 2, rejected: 1 });
    expect(JSON.stringify(body)).not.toContain("bridge-secret");
  });

  test("releases the branch lease when the upstream stream errors after fetch", async () => {
    const handler = createSplitBridgeHandler({
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://gateway.example/v1",
      gatewayAdmissionToken: "bridge-secret",
      nativeMaxActive: 1,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("upstream stream failed"));
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } }),
    });

    const response = await handler(postRequest("gpt-5.6-luna"));
    expect(response.status).toBe(200);
    let streamError: unknown;
    try {
      await response.arrayBuffer();
    } catch (error) {
      streamError = error;
    }
    expect(streamError).toBeInstanceOf(Error);
    expect((streamError as Error).message).toBe("upstream stream failed");

    const health = await handler(new Request("http://127.0.0.1:10101/healthz"));
    const body = await health.json() as { admission?: { native?: { active?: number } } };
    expect(body.admission?.native?.active).toBe(0);
  });

  test("releases and cancels the upstream when the client aborts after fetch", async () => {
    let upstreamCancels = 0;
    const handler = createSplitBridgeHandler({
      catalog,
      nativeBaseUrl: "https://native.example",
      gatewayBaseUrl: "http://gateway.example/v1",
      gatewayAdmissionToken: "bridge-secret",
      nativeMaxActive: 1,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        cancel() {
          upstreamCancels += 1;
        },
      }), { status: 200 }),
    });
    const controller = new AbortController();
    const response = await handler(new Request("http://127.0.0.1:10101/v1/responses", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "hello", stream: true }),
    }));
    expect(response.status).toBe(200);
    controller.abort(new Error("client disconnected"));
    await Bun.sleep(0);

    const health = await handler(new Request("http://127.0.0.1:10101/healthz"));
    const body = await health.json() as { admission?: { native?: { active?: number } } };
    expect(body.admission?.native?.active).toBe(0);
    expect(upstreamCancels).toBe(1);
  });

  test("classifies trusted 10100 bridge requests without granting an invalid token a branch", () => {
    const make = (token: string, selector?: string) => new Request("http://127.0.0.1:10100/v1/responses", {
      headers: {
        [SPLIT_BRIDGE_ADMISSION_HEADER]: token,
        ...(selector === undefined ? {} : { [SPLIT_BRIDGE_ACCOUNT_SELECTOR_HEADER]: selector }),
      },
    });
    expect(hasSplitBridgeAdmission(make("bridge-secret"), "bridge-secret")).toBe(true);
    expect(splitBridgeTrafficBranch(make("bridge-secret"), "bridge-secret")).toBe("gateway");
    expect(splitBridgeTrafficBranch(make("bridge-secret", "team/gpt-5.6-luna"), "bridge-secret")).toBe("native");
    expect(splitBridgeTrafficBranch(make("wrong", "team/gpt-5.6-luna"), "bridge-secret")).toBeNull();
  });

  test("wires split gates only for trusted split branch traffic in the gateway", () => {
    const source = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
    expect(source).toContain("createSplitAdmissionGates");
    expect(source).toContain("splitBridgeTrafficBranch");
    expect(source).toContain("tryAdmitTurn(admissionGate)");
    expect(source).toContain("const splitAdmissionGates = splitModeActive");
    expect(source).toContain("createSplitAdmissionGates(deps.splitAdmissionLimits)");
  });
});
