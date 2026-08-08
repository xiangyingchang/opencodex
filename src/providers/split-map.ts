export type ProviderSplitChannel =
  | "official-native"
  | "official-native-account"
  | "official-api-key"
  | "third-party-gateway"
  | "invalid";

export interface ProviderSplitCatalog {
  readonly generation: string;
  readonly officialModels: ReadonlySet<string>;
  readonly officialAccountNamespaces: ReadonlySet<string>;
  readonly officialApiKeyModels: ReadonlySet<string>;
  readonly thirdPartyModels: ReadonlySet<string>;
}

export interface ProviderSplitDecision {
  readonly channel: ProviderSplitChannel;
  readonly canonicalModel: string | null;
  readonly provider: string | null;
  readonly reason: string;
}

function invalidDecision(reason = "unknown-model"): ProviderSplitDecision {
  return {
    channel: "invalid",
    canonicalModel: null,
    provider: null,
    reason,
  };
}

/**
 * Classify a Codex-facing catalog slug into a physical provider split channel.
 *
 * This function is intentionally pure: callers must provide the last-known-good catalog,
 * and unknown values fail closed rather than falling through to a default provider.
 */
export function classifyProviderSplitModel(
  requestedModel: string,
  catalog: ProviderSplitCatalog,
): ProviderSplitDecision {
  if (typeof requestedModel !== "string" || requestedModel.trim().length === 0) {
    return invalidDecision();
  }

  // Official native rows win over any colliding third-party row.
  if (catalog.officialModels.has(requestedModel)) {
    return {
      channel: "official-native",
      canonicalModel: requestedModel,
      provider: "openai",
      reason: "official-model-allowlist",
    };
  }

  if (catalog.officialApiKeyModels.has(requestedModel)) {
    return {
      channel: "official-api-key",
      canonicalModel: requestedModel,
      provider: "openai-apikey",
      reason: "official-api-key-allowlist",
    };
  }

  const separator = requestedModel.indexOf("/");
  if (separator > 0 && separator < requestedModel.length - 1) {
    const namespace = requestedModel.slice(0, separator);
    const model = requestedModel.slice(separator + 1);
    if (catalog.officialAccountNamespaces.has(namespace) && catalog.officialModels.has(model)) {
      return {
        channel: "official-native-account",
        canonicalModel: model,
        provider: "openai",
        reason: "official-account-namespace",
      };
    }
  }

  if (catalog.thirdPartyModels.has(requestedModel)) {
    const provider = requestedModel.slice(0, separator);
    if (separator > 0 && provider.length > 0) {
      return {
        channel: "third-party-gateway",
        canonicalModel: requestedModel,
        provider,
        reason: "third-party-model-allowlist",
      };
    }
  }

  return invalidDecision();
}
