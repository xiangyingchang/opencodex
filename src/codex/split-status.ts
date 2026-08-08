import type { CodexRoutingMode } from "../types";

export type SplitBridgeReadiness =
  | "ready"
  | "bridge-unavailable"
  | "gateway-unavailable"
  | "legacy-mode";

export interface SplitBridgeStatusInput {
  readonly desiredMode: CodexRoutingMode;
  readonly splitBridgeRunning: boolean;
  readonly gatewayReachable: boolean;
  readonly catalogGeneration: string | null;
}

export interface SplitBridgeStatus {
  readonly desiredMode: CodexRoutingMode;
  readonly splitBridgeRunning: boolean;
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
    : !input.splitBridgeRunning
      ? "bridge-unavailable"
      : !input.gatewayReachable
        ? "gateway-unavailable"
        : "ready";
  return {
    desiredMode: input.desiredMode,
    splitBridgeRunning: input.splitBridgeRunning,
    splitBridgePort: 10101,
    officialPath: input.desiredMode === "split" ? "direct" : "legacy-local",
    thirdPartyPath: "gateway",
    gatewayReachable: input.gatewayReachable,
    catalogGeneration: input.catalogGeneration,
    routingDependency: input.desiredMode === "split" ? "split-bridge-not-gateway" : "legacy-local",
    readiness,
  };
}
