import { createAdmissionGate } from "../lib/admission";
import type { ProviderSplitChannel } from "../providers/split-map";

/** Keep the two split domains bounded without changing the legacy-local ceiling. */
export const DEFAULT_SPLIT_NATIVE_MAX_ACTIVE_TURNS = 128;
export const DEFAULT_SPLIT_GATEWAY_MAX_ACTIVE_TURNS = 128;

export type SplitAdmissionBranch = "native" | "gateway";

export interface SplitAdmissionLimits {
  readonly native?: number;
  readonly gateway?: number;
}

export type SplitAdmissionGate = ReturnType<typeof createAdmissionGate>;

export interface SplitAdmissionGates {
  readonly native: SplitAdmissionGate;
  readonly gateway: SplitAdmissionGate;
}

export function createSplitAdmissionGates(
  limits: SplitAdmissionLimits = {},
): SplitAdmissionGates {
  return {
    native: createAdmissionGate(
      "split_native_turns",
      limits.native ?? DEFAULT_SPLIT_NATIVE_MAX_ACTIVE_TURNS,
    ),
    gateway: createAdmissionGate(
      "split_gateway_turns",
      limits.gateway ?? DEFAULT_SPLIT_GATEWAY_MAX_ACTIVE_TURNS,
    ),
  };
}

/** Map catalog ownership to the logical resource domain, not the physical URL. */
export function splitAdmissionBranchForChannel(
  channel: ProviderSplitChannel,
): SplitAdmissionBranch | null {
  if (channel === "official-native" || channel === "official-native-account") return "native";
  if (channel === "third-party-gateway" || channel === "official-api-key") return "gateway";
  return null;
}
