export type ProviderSplitChannel =
  | "official-native"
  | "official-native-account"
  | "official-api-key"
  | "third-party-gateway"
  | "invalid";

export interface ProviderSplitCatalog {
  readonly generation: string;
  readonly officialModels: ReadonlySet<string>;
  /** Exact public account-qualified slugs; never infer these as a cross-product. */
  readonly officialAccountSlugs: ReadonlySet<string>;
  /** Derived metadata for status/catalog consumers, not routing ownership. */
  readonly officialAccountNamespaces: ReadonlySet<string>;
  readonly officialAccountModels: ReadonlySet<string>;
  readonly officialApiKeyModels: ReadonlySet<string>;
  readonly thirdPartyModels: ReadonlySet<string>;
}

export interface ProviderSplitDecision {
  readonly channel: ProviderSplitChannel;
  readonly canonicalModel: string | null;
  readonly provider: string | null;
  readonly reason: string;
}

export type ProviderSplitCatalogOwnership = Omit<ProviderSplitCatalog, "generation">;

/**
 * Reject catalog identities that could be claimed by more than one physical channel.
 * The classifier keeps an official-first defensive order, but a production catalog
 * must not rely on that order to resolve an ownership conflict.
 */
export function assertProviderSplitCatalogDisjoint(catalog: ProviderSplitCatalogOwnership): void {
  const owners = new Map<string, string>();
  const claim = (identity: string, owner: string): void => {
    const previous = owners.get(identity);
    if (previous !== undefined && previous !== owner) {
      throw new Error(`Provider split catalog overlap for ${identity}: ${previous} vs ${owner}`);
    }
    owners.set(identity, owner);
  };

  for (const model of catalog.officialModels) claim(model, "official-native");
  for (const model of catalog.officialApiKeyModels) claim(model, "official-api-key");
  for (const model of catalog.thirdPartyModels) claim(model, "third-party-gateway");
  for (const slug of catalog.officialAccountSlugs) claim(slug, "official-native-account");
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
      // The split bridge has one native ChatGPT/Codex base. Sending an
      // `openai-apikey/*` slug there would silently use the wrong credential
      // domain; 10100 owns the configured OpenAI API key transport instead.
      channel: "third-party-gateway",
      canonicalModel: requestedModel,
      provider: "openai-apikey",
      reason: "official-api-key-gateway-policy",
    };
  }

  const separator = requestedModel.indexOf("/");
  if (catalog.officialAccountSlugs.has(requestedModel) && separator > 0 && separator < requestedModel.length - 1) {
    return {
      channel: "official-native-account",
      canonicalModel: requestedModel.slice(separator + 1),
      provider: "openai",
      reason: "official-account-namespace",
    };
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
