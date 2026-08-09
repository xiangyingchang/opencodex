import { describe, expect, test } from "bun:test";
import { deriveSplitBridgeStatus } from "../src/codex/split-status";

describe("Codex split bridge status contract", () => {
  test("reports independent paths and a ready split plane", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "split",
      splitBridgeRunning: true,
      bridgeLiveness: true,
      bridgePid: 4242,
      nativeRouteConfigured: true,
      nativeTransportReady: true,
      routingInjected: true,
      configurationInvalid: false,
      gatewayAdmissionConfigured: true,
      launchAgentInstalled: true,
      launchAgentLoaded: true,
      launchAgentMatchesPlist: true,
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
      bridgeLiveness: true,
      bridgePid: 4242,
      nativeRouteConfigured: true,
      nativeTransportReady: true,
      routingInjected: true,
      configurationInvalid: false,
      gatewayAdmissionConfigured: true,
      launchAgentInstalled: true,
      launchAgentLoaded: true,
      launchAgentMatchesPlist: true,
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
      bridgeLiveness: false,
      bridgePid: null,
      nativeRouteConfigured: true,
      nativeTransportReady: true,
      routingInjected: true,
      configurationInvalid: false,
      gatewayAdmissionConfigured: true,
      launchAgentInstalled: true,
      launchAgentLoaded: true,
      launchAgentMatchesPlist: true,
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
      bridgeLiveness: false,
      bridgePid: null,
      nativeRouteConfigured: false,
      nativeTransportReady: false,
      routingInjected: false,
      configurationInvalid: false,
      gatewayAdmissionConfigured: true,
      launchAgentInstalled: false,
      launchAgentLoaded: false,
      launchAgentMatchesPlist: false,
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

  test("health alone does not claim readiness without injection and transport proof", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "split",
      splitBridgeRunning: true,
      bridgeLiveness: true,
      bridgePid: 4242,
      nativeRouteConfigured: false,
      nativeTransportReady: false,
      routingInjected: false,
      configurationInvalid: false,
      gatewayAdmissionConfigured: true,
      launchAgentInstalled: true,
      launchAgentLoaded: true,
      launchAgentMatchesPlist: true,
      gatewayReachable: true,
      catalogGeneration: "generation-1",
    });

    expect(status.readiness).toBe("routing-not-injected");
    expect(status.bridgeLiveness).toBe(true);
    expect(status.nativeTransportReady).toBe(false);
  });

  test("missing gateway admission is configuration-invalid even when both ports are live", () => {
    const status = deriveSplitBridgeStatus({
      desiredMode: "split",
      splitBridgeRunning: true,
      bridgeLiveness: true,
      bridgePid: 4242,
      nativeRouteConfigured: true,
      nativeTransportReady: true,
      routingInjected: true,
      configurationInvalid: false,
      gatewayAdmissionConfigured: false,
      launchAgentInstalled: true,
      launchAgentLoaded: true,
      launchAgentMatchesPlist: true,
      gatewayReachable: true,
      catalogGeneration: "generation-1",
    });

    expect(status.readiness).toBe("configuration-invalid");
  });
});
