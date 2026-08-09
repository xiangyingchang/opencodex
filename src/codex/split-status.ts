import type { CodexRoutingMode } from "../types";

export type SplitBridgeReadiness =
  | "ready"
  | "bridge-unavailable"
  | "gateway-unavailable"
  | "configuration-invalid"
  | "routing-not-injected"
  | "transport-unverified"
  | "catalog-unavailable"
  | "legacy-mode";

export interface SplitBridgeStatusInput {
  readonly desiredMode: CodexRoutingMode;
  readonly splitBridgeRunning: boolean;
  readonly bridgeLiveness: boolean;
  readonly bridgePid: number | null;
  readonly nativeRouteConfigured: boolean;
  readonly nativeTransportReady: boolean;
  readonly routingInjected: boolean;
  readonly configurationInvalid: boolean;
  readonly gatewayAdmissionConfigured: boolean;
  readonly launchAgentInstalled: boolean;
  readonly launchAgentLoaded: boolean;
  readonly launchAgentMatchesPlist: boolean;
  readonly gatewayReachable: boolean;
  readonly catalogGeneration: string | null;
}

export interface SplitBridgeStatus {
  readonly desiredMode: CodexRoutingMode;
  readonly splitBridgeRunning: boolean;
  readonly bridgeLiveness: boolean;
  readonly bridgePid: number | null;
  readonly nativeRouteConfigured: boolean;
  readonly nativeTransportReady: boolean;
  readonly routingInjected: boolean;
  readonly configurationInvalid: boolean;
  readonly gatewayAdmissionConfigured: boolean;
  readonly launchAgentInstalled: boolean;
  readonly launchAgentLoaded: boolean;
  readonly launchAgentMatchesPlist: boolean;
  readonly splitBridgePort: 10101;
  readonly officialPath: "direct" | "legacy-local";
  readonly thirdPartyPath: "gateway";
  readonly gatewayReachable: boolean;
  readonly catalogGeneration: string | null;
  readonly routingDependency: "split-bridge-not-gateway" | "legacy-local";
  readonly readiness: SplitBridgeReadiness;
}

/**
 * Pure status projection for the two-plane architecture. In particular, a
 * reachable gateway is never used as evidence that the split bridge is alive,
 * and a dead gateway never changes the official path label.
 */
export function deriveSplitBridgeStatus(input: SplitBridgeStatusInput): SplitBridgeStatus {
  const readiness: SplitBridgeReadiness = input.desiredMode !== "split"
    ? "legacy-mode"
    : input.configurationInvalid || !input.gatewayAdmissionConfigured
      || !input.launchAgentInstalled || !input.launchAgentLoaded || !input.launchAgentMatchesPlist
      ? "configuration-invalid"
    : !input.splitBridgeRunning
      ? "bridge-unavailable"
      : !input.nativeRouteConfigured || !input.routingInjected
        ? "routing-not-injected"
        : !input.nativeTransportReady
          ? "transport-unverified"
          : !input.catalogGeneration
            ? "catalog-unavailable"
      : !input.gatewayReachable
        ? "gateway-unavailable"
        : "ready";
  return {
    desiredMode: input.desiredMode,
    splitBridgeRunning: input.splitBridgeRunning,
    bridgeLiveness: input.splitBridgeRunning,
    bridgePid: input.bridgePid,
    nativeRouteConfigured: input.nativeRouteConfigured,
    nativeTransportReady: input.nativeTransportReady,
    routingInjected: input.routingInjected,
    configurationInvalid: input.configurationInvalid,
    gatewayAdmissionConfigured: input.gatewayAdmissionConfigured,
    launchAgentInstalled: input.launchAgentInstalled,
    launchAgentLoaded: input.launchAgentLoaded,
    launchAgentMatchesPlist: input.launchAgentMatchesPlist,
    splitBridgePort: 10101,
    officialPath: input.desiredMode === "split" ? "direct" : "legacy-local",
    thirdPartyPath: "gateway",
    gatewayReachable: input.gatewayReachable,
    catalogGeneration: input.catalogGeneration,
    routingDependency: input.desiredMode === "split" ? "split-bridge-not-gateway" : "legacy-local",
    readiness,
  };
}
