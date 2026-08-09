import { createHash } from "node:crypto";
import {
  assertProviderSplitCatalogDisjoint,
  type ProviderSplitCatalog,
} from "../providers/split-map";
import { SUPPORTED_NATIVE_OPENAI_SLUGS } from "./catalog/metadata";

export interface SplitCatalogEntry {
  readonly slug?: unknown;
  readonly visibility?: unknown;
}

export interface BuildProviderSplitCatalogOptions {
  readonly entries: readonly SplitCatalogEntry[];
  readonly officialAccountNamespaces: readonly string[];
  readonly disabledModels?: readonly string[];
  /** Deliberately ignored: health must not mutate model-picker identity. */
  readonly gatewayReachable?: boolean;
}

function splitIdentity(slug: string): { namespace: string; model: string } | null {
  const slash = slug.indexOf("/");
  if (slash <= 0 || slash >= slug.length - 1) return null;
  return { namespace: slug.slice(0, slash), model: slug.slice(slash + 1) };
}

function generationFor(catalog: Omit<ProviderSplitCatalog, "generation">): string {
  const rows = [
    ...[...catalog.officialModels].sort().map(model => `native:${model}`),
    ...[...catalog.officialAccountSlugs].sort().map(slug => `account:${slug}`),
    ...[...catalog.officialApiKeyModels].sort().map(model => `apikey:${model}`),
    ...[...catalog.thirdPartyModels].sort().map(model => `thirdparty:${model}`),
  ];
  return createHash("sha256").update(rows.join("\n"), "utf8").digest("hex");
}

/**
 * Build the bridge catalog from the already-materialized Codex picker rows.
 *
 * This function never performs live discovery and never filters third-party rows
 * based on gateway health. A stale-but-valid catalog is preferable to making the
 * App picker disappear whenever the gateway is restarting.
 */
export function buildProviderSplitCatalog(options: BuildProviderSplitCatalogOptions): ProviderSplitCatalog {
  void options.gatewayReachable;
  const disabled = new Set(options.disabledModels ?? []);
  const accountNamespaces = new Set(options.officialAccountNamespaces.filter(value => value.trim().length > 0));
  const officialModels = new Set<string>();
  const officialAccountSlugs = new Set<string>();
  const officialAccountModels = new Set<string>();
  const officialApiKeyModels = new Set<string>();
  const thirdPartyModels = new Set<string>();

  for (const entry of options.entries) {
    if (entry.visibility !== "list" || typeof entry.slug !== "string") continue;
    const slug = entry.slug;
    if (disabled.has(slug)) continue;

    const identity = splitIdentity(slug);
    if (!identity) {
      if (SUPPORTED_NATIVE_OPENAI_SLUGS.has(slug)) officialModels.add(slug);
      continue;
    }

    if (identity.namespace === "openai-apikey" && SUPPORTED_NATIVE_OPENAI_SLUGS.has(identity.model)) {
      officialApiKeyModels.add(slug);
      continue;
    }

    if (accountNamespaces.has(identity.namespace) && SUPPORTED_NATIVE_OPENAI_SLUGS.has(identity.model)) {
      officialAccountSlugs.add(slug);
      officialAccountModels.add(identity.model);
      continue;
    }

    thirdPartyModels.add(slug);
  }

  const base = {
    officialModels,
    officialAccountSlugs,
    officialAccountModels,
    officialAccountNamespaces: new Set(
      [...accountNamespaces].filter(namespace =>
        [...officialAccountSlugs].some(slug => splitIdentity(slug)?.namespace === namespace),
      ),
    ),
    officialApiKeyModels,
    thirdPartyModels,
  } satisfies Omit<ProviderSplitCatalog, "generation">;

  assertProviderSplitCatalogDisjoint(base);
  return { ...base, generation: generationFor(base) };
}
