/** ChatGPT/Codex wire ids observed for account-native model surfaces. */
export const NATIVE_DAYBREAK_BLUE_MODEL = "gpt-daybreak-blue-latest";
export const NATIVE_GPT6_ASTRA_MODEL = "gpt-6-astra";

/** Native ChatGPT/Codex ids whose availability is proven per authenticated account. */
export const ACCOUNT_GATED_NATIVE_OPENAI_MODELS: ReadonlySet<string> = new Set([
  NATIVE_DAYBREAK_BLUE_MODEL,
  NATIVE_GPT6_ASTRA_MODEL,
]);

/**
 * Account-native aliases whose Codex capabilities track another pinned native row.
 *
 * This is catalog metadata inheritance only. Each alias remains its own product identity;
 * API-key routes preserve their requested wire id, and the ChatGPT/Codex route applies any
 * separately verified wire normalization at the transport boundary.
 *
 * Daybreak currently has that normalization because the authenticated backend rejects its
 * gated slug on some shards; Astra is intentionally left on its roster-advertised wire id
 * until a corresponding transport observation exists. The catalog keeps the product identity;
 * only the verified wire mapping moves.
 */
const NATIVE_OPENAI_CAPABILITY_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  [NATIVE_DAYBREAK_BLUE_MODEL]: "gpt-5.6-sol",
  [NATIVE_GPT6_ASTRA_MODEL]: "gpt-5.6-sol",
});

export interface NativeOpenAiCapabilityPresentation {
  readonly displayName: string;
  readonly description: string;
}

const NATIVE_OPENAI_CAPABILITY_PRESENTATIONS: Readonly<Record<string, NativeOpenAiCapabilityPresentation>> = Object.freeze({
  [NATIVE_DAYBREAK_BLUE_MODEL]: {
    displayName: "Daybreak Blue",
    description: "Frontier general-purpose model with safeguards for defensive cybersecurity work.",
  },
  [NATIVE_GPT6_ASTRA_MODEL]: {
    displayName: "GPT-6-Astra",
    description: "GPT-6-Astra (Codex OAuth passthrough).",
  },
});

/**
 * Native ids whose capability metadata is inherited from another pinned native row.
 *
 * Membership here is about METADATA INHERITANCE only, and is independent of whether the
 * slug is also present in `NATIVE_OPENAI_MODELS`. `gpt-daybreak-blue-latest` is now in BOTH:
 * it inherits Sol's capability shape AND is a supported account-gated native id (owner decision,
 * devlog 260816_codexrs_multiagent_v2_and_history_perf/011).
 *
 * The maps that consume the union of these two lists (`PINNED_NATIVE_CAPABILITY_ENTRIES`,
 * `UPSTREAM_NATIVE_ENTRIES`) are keyed by slug, so an overlapping id collapses to one
 * entry. Catalog row generation iterates `NATIVE_OPENAI_MODELS`, then entitlement evidence limits
 * it to at most one bare row and one row per entitled account selector.
 */
export const NATIVE_OPENAI_CAPABILITY_ALIAS_MODELS = Object.freeze(
  Object.keys(NATIVE_OPENAI_CAPABILITY_SOURCES),
);

export function isNativeOpenAiCapabilityAliasModel(slug: string): boolean {
  return Object.hasOwn(NATIVE_OPENAI_CAPABILITY_SOURCES, slug);
}

export function nativeOpenAiCapabilitySourceSlug(slug: string): string {
  return NATIVE_OPENAI_CAPABILITY_SOURCES[slug] ?? slug;
}

export function nativeOpenAiCapabilityPresentation(
  slug: string,
): NativeOpenAiCapabilityPresentation | undefined {
  return NATIVE_OPENAI_CAPABILITY_PRESENTATIONS[slug];
}

/**
 * Native OpenAI model ids that this release can route and restore with authoritative metadata.
 *
 * The account-gated ids are entitlement-gated upstream: they are absent from codex-rs's bundled
 * catalog and reach a client only through an authenticated `/models` response. They are listed
 * here so the capability template exists without waiting for an observation, because opencodex
 * injects `model_catalog_json` and codex-rs therefore builds a `StaticModelsManager` whose
 * refresh is a no-op — an entitled account had no way to discover one on a clean install.
 *
 * Availability is not static: catalog sync and Pool routing require the account's authenticated
 * `/models` roster to contain the slug. An unconfirmed or unentitled account never receives the
 * request. `disabledModels` remains the independent user visibility control.
 *
 * Devlog: 260816_codexrs_multiagent_v2_and_history_perf/011 §4-bis.
 */
export const NATIVE_OPENAI_MODELS = [
  "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex-spark",
  "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
  NATIVE_DAYBREAK_BLUE_MODEL, NATIVE_GPT6_ASTRA_MODEL,
];

export const SUPPORTED_NATIVE_OPENAI_SLUGS = new Set(NATIVE_OPENAI_MODELS);
