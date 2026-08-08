import { describe, expect, test } from "bun:test";
import { deriveSplitBridgeStatus } from "../src/codex/split-status";

describe("Codex split bridge status contract", () => {
  test("reports independent paths and a ready split plane", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "split",
      splitBridgeRunning: true,
      gatewayReachable: true,
      catalogGeneration: "generation-1",
    });

    expect(status).toMatchObject({
      splitBridgeRunning: true,
      splitBridgePort: 10101,
      officialPath: "direct",
      thirdPartyPath: "gateway",
      gatewayReachable: true,
      catalogGeneration: "generation-1",
      routingDependency: "split-bridge-not-gateway",
      readiness: "ready",
    });
  });

  test("gateway down does not make the official path unavailable or mutate catalog identity", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "split",
      splitBridgeRunning: true,
      gatewayReachable: false,
      catalogGeneration: "generation-1",
    });

    expect(status).toMatchObject({
      officialPath: "direct",
      thirdPartyPath: "gateway",
      splitBridgeRunning: true,
      gatewayReachable: false,
      catalogGeneration: "generation-1",
      readiness: "gateway-unavailable",
    });
  });

  test("bridge down is distinct from gateway down", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "split",
      splitBridgeRunning: false,
      gatewayReachable: true,
      catalogGeneration: "generation-1",
    });

    expect(status.readiness).toBe("bridge-unavailable");
    expect(status.routingDependency).toBe("split-bridge-not-gateway");
  });

  test("legacy mode is explicit and does not claim split readiness", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "legacy-local",
      splitBridgeRunning: false,
      gatewayReachable: true,
      catalogGeneration: "generation-1",
    });

    expect(status).toMatchObject({
      readiness: "legacy-mode",
      splitBridgeRunning: false,
      officialPath: "legacy-local",
      thirdPartyPath: "gateway",
      routingDependency: "legacy-local",
      catalogGeneration: "generation-1",
    });
  });
});
