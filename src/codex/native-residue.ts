import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  readSync,
  statSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Database, constants } from "bun:sqlite";

import { getConfigDir } from "../config";
import { catalogHasRoutedEntries, parseCatalogJson } from "./catalog/parsing";
import {
  hasInjectedCodexRouting,
  OCX_SECTION_MARKER,
  providerTableString,
  rootTomlString,
} from "./injected-marker";
import {
  CODEX_CONFIG_PATH,
  CODEX_MODELS_CACHE_PATH,
  CODEX_PROFILE_PATH,
  DEFAULT_CATALOG_PATH,
  getCodexHome,
  readRootTomlString,
  resolveCodexStateDbPath,
} from "./paths";

export type NativeResidueSurface =
  | "config"
  | "profile"
  | "catalog"
  | "models-cache"
  | "journal"
  | "partial-write"
  | "history"
  | "history-backup";

export type NativeRoutedResidueResult =
  | { kind: "clean" }
  | { kind: "residue"; surface: NativeResidueSurface; path: string }
  | { kind: "indeterminate"; surface: NativeResidueSurface; path: string; reason: string };

const UNMARKED_PROFILE_REASON = "OpenCodex-shaped TOML does not match a complete routed grammar";

/** A valid profile with no ownership marker can be snapshotted safely; malformed surfaces cannot. */
export function isUnmarkedProfileResidue(
  residue: { kind: string; surface?: string; reason?: string },
): boolean {
  return residue.kind === "indeterminate"
    && residue.surface === "profile"
    && residue.reason === UNMARKED_PROFILE_REASON;
}

type ReadResult =
  | { kind: "absent" }
  | { kind: "content"; content: string; path: string }
  | { kind: "indeterminate"; reason: string };

type PathResult =
  | { kind: "absent" }
  | { kind: "path"; path: string; stat: Stats }
  | { kind: "indeterminate"; reason: string };

type PathIdentity = {
  lstat: Stats;
  realpath: string;
};

type PathIdentityResult =
  | { kind: "absent" }
  | { kind: "path"; identity: PathIdentity }
  | { kind: "indeterminate"; reason: string };

type CatalogTarget = {
  path: string;
  configured: boolean;
};

type ConfigObservation = {
  classification: NativeRoutedResidueResult;
  catalogTargets: CatalogTarget[];
};

type RolloutReference = {
  id: string;
  path: string;
  provider: RolloutProvider;
};

const CONFIG_FILE_NAME = basename(CODEX_CONFIG_PATH);
const PROFILE_FILE_NAME = basename(CODEX_PROFILE_PATH);
const CATALOG_FILE_NAME = basename(DEFAULT_CATALOG_PATH);
const MODELS_CACHE_FILE_NAME = basename(CODEX_MODELS_CACHE_PATH);
const JOURNAL_FILE_NAME = "opencodex-journal.json";
const ROUTED_CATALOG_DESCRIPTION_PREFIX = "Routed via opencodex → ";
const MAX_ROLLOUT_RECORD_BYTES = 16 * 1024 * 1024;
const ROLLOUT_READ_CHUNK_BYTES = 64 * 1024;
type RolloutProvider = "openai" | "opencodex" | "custom";
const KNOWN_ROLLOUT_PROVIDERS: ReadonlySet<RolloutProvider> = new Set([
  "openai",
  "opencodex",
  "custom",
]);

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function errorReason(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function sameStat(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function samePathIdentity(
  left: Stats,
  right: Stats,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function capturePathIdentity(path: string): PathIdentityResult {
  let lstat: Stats;
  try {
    lstat = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "indeterminate", reason: errorReason(error) };
  }

  try {
    return { kind: "path", identity: { lstat, realpath: realpathSync.native(path) } };
  } catch (error) {
    return { kind: "indeterminate", reason: `unresolvable path: ${errorReason(error)}` };
  }
}

function resolveRegularFile(path: string): PathResult {
  let entry;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { kind: "absent" };
    return { kind: "indeterminate", reason: errorReason(error) };
  }

  let target = path;
  if (entry.isSymbolicLink()) {
    try {
      target = realpathSync.native(path);
    } catch (error) {
      return { kind: "indeterminate", reason: `unresolvable symlink: ${errorReason(error)}` };
    }
  }

  try {
    const before = statSync(target);
    if (!before.isFile()) {
      return { kind: "indeterminate", reason: "surface is not a regular file" };
    }
    return { kind: "path", path: target, stat: before };
  } catch (error) {
    return { kind: "indeterminate", reason: errorReason(error) };
  }
}

function readRegularFile(path: string): ReadResult {
  const resolved = resolveRegularFile(path);
  if (resolved.kind !== "path") return resolved;
  try {
    const content = readFileSync(resolved.path, "utf8");
    const after = statSync(resolved.path);
    if (!sameStat(resolved.stat, after)) {
      return { kind: "indeterminate", reason: "surface changed while it was being observed" };
    }
    return { kind: "content", content, path: resolved.path };
  } catch (error) {
    return { kind: "indeterminate", reason: errorReason(error) };
  }
}

function indeterminate(
  surface: NativeResidueSurface,
  path: string,
  reason: string,
): NativeRoutedResidueResult {
  return { kind: "indeterminate", surface, path, reason };
}

function rolloutSessionMetaPayload(
  line: string,
): { kind: "payload"; payload: Record<string, unknown> | null } | { kind: "malformed"; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    return { kind: "malformed", reason: `malformed rollout JSONL: ${errorReason(error)}` };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "rollout JSONL record is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "session_meta") return { kind: "payload", payload: null };
  if (!record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    return { kind: "malformed", reason: "session_meta payload has an unknown shape" };
  }
  return { kind: "payload", payload: record.payload as Record<string, unknown> };
}

type RolloutMetadata = {
  first: Record<string, unknown> | undefined;
  latest: Record<string, unknown> | undefined;
  hasOpenCodexProvider: boolean;
  providers: Set<RolloutProvider>;
};

function isKnownRolloutProvider(provider: string): provider is RolloutProvider {
  return KNOWN_ROLLOUT_PROVIDERS.has(provider as RolloutProvider);
}

function consumeRolloutLines(
  surface: "history" | "history-backup",
  path: string,
  referenceId: string,
  partial: string,
  metadata: RolloutMetadata,
): NativeRoutedResidueResult | { kind: "continue"; partial: string } {
  let rest = partial;
  let newline = rest.indexOf("\n");
  while (newline !== -1) {
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (Buffer.byteLength(line, "utf8") > MAX_ROLLOUT_RECORD_BYTES) {
      return indeterminate(
        surface,
        path,
        `rollout JSONL record exceeds the ${MAX_ROLLOUT_RECORD_BYTES} byte limit`,
      );
    }
    if (line.trim()) {
      const payload = rolloutSessionMetaPayload(line);
      if (payload.kind === "malformed") {
        return indeterminate(surface, path, payload.reason);
      }
      if (payload.payload !== null) {
        if (typeof payload.payload.id !== "string" || !payload.payload.id) {
          return indeterminate(surface, path, "session_meta has no thread metadata");
        }
        const provider = payload.payload.model_provider;
        if (typeof provider !== "string" || !provider) {
          return indeterminate(surface, path, "session_meta has no provider metadata");
        }
        if (!isKnownRolloutProvider(provider)) {
          return indeterminate(surface, path, "session_meta has unknown provider metadata");
        }
        metadata.providers.add(provider);
        if (provider === "opencodex") {
          if (payload.payload.id !== referenceId) {
            return indeterminate(surface, path, "session_meta does not identify the referenced thread");
          }
          metadata.hasOpenCodexProvider = true;
        }
        metadata.first ??= payload.payload;
        metadata.latest = payload.payload;
      }
    }
    newline = rest.indexOf("\n");
  }
  if (Buffer.byteLength(rest, "utf8") > MAX_ROLLOUT_RECORD_BYTES) {
    return indeterminate(
      surface,
      path,
      `rollout JSONL record exceeds the ${MAX_ROLLOUT_RECORD_BYTES} byte limit`,
    );
  }
  return { kind: "continue", partial: rest };
}

function classifyToml(
  surface: "config" | "profile",
  path: string,
  classify: (content: string) => "clean" | "residue" | "indeterminate",
): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate(surface, path, read.reason);
  try {
    Bun.TOML.parse(read.content);
  } catch (error) {
    return indeterminate(surface, path, `malformed TOML: ${errorReason(error)}`);
  }
  const result = classify(read.content);
  if (result === "residue") return { kind: "residue", surface, path: read.path };
  if (result === "indeterminate") {
    return indeterminate(surface, read.path, "OpenCodex-shaped TOML does not match a complete routed grammar");
  }
  return { kind: "clean" };
}

function catalogPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function catalogTargets(
  codexHome: string,
  configuredPaths: readonly string[] = [],
): CatalogTarget[] {
  const targets = new Map<string, CatalogTarget>();
  const add = (path: string, configured: boolean) => {
    const key = catalogPathKey(path);
    const existing = targets.get(key);
    targets.set(key, { path: resolve(path), configured: configured || existing?.configured === true });
  };
  for (const configuredPath of configuredPaths) {
    add(resolve(codexHome, configuredPath), true);
  }
  add(join(codexHome, CATALOG_FILE_NAME), false);
  return [...targets.values()];
}

function inspectConfig(codexHome: string, path: string): ConfigObservation {
  const read = readRegularFile(path);
  if (read.kind === "absent") {
    return { classification: { kind: "clean" }, catalogTargets: catalogTargets(codexHome) };
  }
  if (read.kind === "indeterminate") {
    return {
      classification: indeterminate("config", path, read.reason),
      catalogTargets: catalogTargets(codexHome),
    };
  }

  const productionConfiguredPath = readRootTomlString(read.content, "model_catalog_json");
  const productionConfiguredPaths = productionConfiguredPath === null
    ? []
    : [productionConfiguredPath];
  let parsed: unknown;
  try {
    parsed = Bun.TOML.parse(read.content.replace(/^\uFEFF/, ""));
  } catch (error) {
    return {
      classification: indeterminate("config", read.path, `malformed TOML: ${errorReason(error)}`),
      catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      classification: indeterminate("config", read.path, "TOML root is not a table"),
      catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
    };
  }

  const document = parsed as Record<string, unknown>;
  let targets: CatalogTarget[];
  if (!Object.hasOwn(document, "model_catalog_json")) {
    targets = catalogTargets(codexHome, productionConfiguredPaths);
  } else if (typeof document.model_catalog_json !== "string" || !document.model_catalog_json.trim()) {
    return {
      classification: indeterminate("config", read.path, "model_catalog_json must be one non-empty string"),
      catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
    };
  } else {
    try {
      targets = catalogTargets(codexHome, [
        ...productionConfiguredPaths,
        document.model_catalog_json,
      ]);
    } catch (error) {
      return {
        classification: indeterminate("config", read.path, `model_catalog_json cannot be resolved: ${errorReason(error)}`),
        catalogTargets: catalogTargets(codexHome, productionConfiguredPaths),
      };
    }
  }

  let classification: NativeRoutedResidueResult = { kind: "clean" };
  if (hasInjectedCodexRouting(read.content)) {
    classification = { kind: "residue", surface: "config", path: read.path };
  } else {
    const hasMarker = read.content.includes(OCX_SECTION_MARKER);
    const provider = rootTomlString(read.content, "model_provider");
    const providerBaseUrl = providerTableString(read.content, "opencodex", "base_url");
    if (hasMarker || provider === "opencodex" || providerBaseUrl !== null) {
      classification = indeterminate(
        "config",
        read.path,
        "OpenCodex-shaped TOML does not match a complete routed grammar",
      );
    }
  }
  return { classification, catalogTargets: targets };
}

function classifyProfile(path: string): NativeRoutedResidueResult {
  return classifyToml("profile", path, content => {
    const generatedFallback = content.startsWith("# OpenCodex proxy fallback config (Design B)")
      && rootTomlString(content, "openai_base_url") !== null;
    const generatedNamedProfile = content.startsWith("# OpenCodex proxy profile — use with:")
      && hasInjectedCodexRouting(content);
    if (generatedFallback || generatedNamedProfile) return "residue";
    return "indeterminate";
  });
}

function isOcxRoutedCatalogEntry(entry: Record<string, unknown>): boolean {
  return typeof entry.description === "string"
    && entry.description.startsWith(ROUTED_CATALOG_DESCRIPTION_PREFIX);
}

function classifyCatalogLike(
  surface: "catalog" | "models-cache",
  path: string,
  configured = false,
): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") {
    return configured
      ? indeterminate(surface, path, "configured catalog target is absent")
      : { kind: "clean" };
  }
  if (read.kind === "indeterminate") return indeterminate(surface, path, read.reason);
  const catalog = parseCatalogJson(read.content);
  if (!catalog) return indeterminate(surface, path, "malformed catalog JSON");
  if ((catalog.models ?? []).some(isOcxRoutedCatalogEntry)) {
    return { kind: "residue", surface, path: read.path };
  }
  if (catalogHasRoutedEntries(catalog)) {
    return indeterminate(surface, read.path, "routed catalog rows lack the OpenCodex authorship signature");
  }
  return { kind: "clean" };
}

function isJournal(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const journal = value as Record<string, unknown>;
  return journal.version === 1
    && typeof journal.originalConfig === "string"
    && (journal.originalProfile === null || typeof journal.originalProfile === "string")
    && typeof journal.pid === "number"
    && Number.isInteger(journal.pid)
    && typeof journal.timestamp === "string";
}

function classifyJournal(path: string): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate("journal", path, read.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (error) {
    return indeterminate("journal", read.path, `malformed journal JSON: ${errorReason(error)}`);
  }
  return isJournal(parsed)
    ? { kind: "residue", surface: "journal", path: read.path }
    : indeterminate("journal", read.path, "journal JSON has an unknown or partial shape");
}

function classifyPartialWrites(targetPaths: string[]): NativeRoutedResidueResult {
  const targetsByParent = new Map<string, { path: string; names: Set<string> }>();
  const addTarget = (path: string) => {
    const parent = dirname(path);
    const key = catalogPathKey(parent);
    const observed = targetsByParent.get(key) ?? { path: parent, names: new Set<string>() };
    observed.names.add(basename(path));
    targetsByParent.set(key, observed);
  };
  for (const path of targetPaths) {
    addTarget(path);
    const resolved = resolveRegularFile(path);
    if (resolved.kind === "path") addTarget(resolved.path);
  }

  for (const target of targetsByParent.values()) {
    let names: string[];
    try {
      names = readdirSync(target.path);
    } catch (error) {
      return indeterminate("partial-write", target.path, errorReason(error));
    }
    for (const name of names) {
      const match = /^(.*)\.ocx\.\d+\.\d+\.tmp$/.exec(name);
      if (match?.[1] && target.names.has(match[1])) {
        return indeterminate("partial-write", join(target.path, name), "OpenCodex atomic-write artifact is still present");
      }
    }
  }
  return { kind: "clean" };
}

function classifyReferencedRollout(
  surface: "history" | "history-backup",
  reference: RolloutReference,
): NativeRoutedResidueResult {
  const originalReference = capturePathIdentity(reference.path);
  if (originalReference.kind === "absent") {
    return indeterminate(surface, reference.path, "referenced rollout is absent");
  }
  if (originalReference.kind === "indeterminate") {
    return indeterminate(surface, reference.path, originalReference.reason);
  }

  const resolved = resolveRegularFile(reference.path);
  if (resolved.kind === "absent") {
    return indeterminate(surface, reference.path, "referenced rollout is absent");
  }
  if (resolved.kind === "indeterminate") return indeterminate(surface, reference.path, resolved.reason);

  let resolvedTargetRealpath: string;
  try {
    resolvedTargetRealpath = realpathSync.native(resolved.path);
  } catch (error) {
    return indeterminate(surface, reference.path, `unresolvable resolved rollout target: ${errorReason(error)}`);
  }
  if (resolvedTargetRealpath !== originalReference.identity.realpath) {
    return indeterminate(surface, reference.path, "rollout reference resolved to a different target before it was observed");
  }

  let handle: number;
  try {
    handle = openSync(resolved.path, "r");
  } catch (error) {
    return indeterminate(surface, resolved.path, `unreadable rollout: ${errorReason(error)}`);
  }

  const rolloutMetadata: RolloutMetadata = {
    first: undefined,
    latest: undefined,
    hasOpenCodexProvider: false,
    providers: new Set(),
  };
  let partial = "";
  let totalRead = 0;
  try {
    const opened = fstatSync(handle);
    if (!sameStat(resolved.stat, opened)) {
      return indeterminate(surface, resolved.path, "rollout changed before it was observed");
    }
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const buffer = Buffer.allocUnsafe(ROLLOUT_READ_CHUNK_BYTES);
    while (totalRead < opened.size) {
      const remaining = Math.min(buffer.length, opened.size - totalRead);
      const count = readSync(handle, buffer, 0, remaining, totalRead);
      if (count === 0) {
        return indeterminate(surface, resolved.path, "rollout read ended before the observed size");
      }
      if (count < 0) {
        return indeterminate(surface, resolved.path, "rollout read ended before the observed size");
      }
      totalRead += count;
      partial += decoder.decode(buffer.subarray(0, count), { stream: true });
      const consumed = consumeRolloutLines(
        surface,
        resolved.path,
        reference.id,
        partial,
        rolloutMetadata,
      );
      if (consumed.kind !== "continue") return consumed;
      partial = consumed.partial;
    }
    partial += decoder.decode();
    const consumed = consumeRolloutLines(
      surface,
      resolved.path,
      reference.id,
      `${partial}\n`,
      rolloutMetadata,
    );
    if (consumed.kind !== "continue") return consumed;
    partial = consumed.partial;
    const after = fstatSync(handle);
    if (!sameStat(resolved.stat, after)) {
      return indeterminate(surface, resolved.path, "rollout changed while it was being observed");
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return indeterminate(surface, resolved.path, "referenced rollout is absent");
    }
    return indeterminate(surface, resolved.path, `unreadable rollout: ${errorReason(error)}`);
  } finally {
    try {
      closeSync(handle);
    } catch {
      // Closing an already-closed descriptor cannot affect the classification.
    }
  }

  let currentReferenceLstat: Stats;
  try {
    currentReferenceLstat = lstatSync(reference.path);
  } catch (error) {
    const reason = errorCode(error) === "ENOENT"
      ? "referenced rollout is absent"
      : `rollout reference path is unreadable: ${errorReason(error)}`;
    return indeterminate(surface, reference.path, reason);
  }
  if (!samePathIdentity(originalReference.identity.lstat, currentReferenceLstat)) {
    return indeterminate(surface, reference.path, "rollout reference path was replaced while it was being observed");
  }

  let currentReferenceRealpath: string;
  try {
    currentReferenceRealpath = realpathSync.native(reference.path);
  } catch (error) {
    return indeterminate(surface, reference.path, `unresolvable rollout reference path: ${errorReason(error)}`);
  }
  if (currentReferenceRealpath !== originalReference.identity.realpath) {
    return indeterminate(surface, reference.path, "rollout reference path resolved to a different target while it was being observed");
  }
  if (currentReferenceRealpath !== resolvedTargetRealpath) {
    return indeterminate(surface, reference.path, "rollout resolved pathname changed while it was being observed");
  }

  let currentResolvedRealpath: string;
  try {
    currentResolvedRealpath = realpathSync.native(resolved.path);
  } catch (error) {
    return indeterminate(surface, reference.path, `unresolvable resolved rollout target: ${errorReason(error)}`);
  }
  if (currentResolvedRealpath !== resolvedTargetRealpath) {
    return indeterminate(surface, reference.path, "rollout resolved target pathname changed while it was being observed");
  }

  let currentResolvedStat: Stats;
  try {
    currentResolvedStat = statSync(resolved.path);
  } catch (error) {
    return indeterminate(surface, reference.path, `unreadable resolved rollout target: ${errorReason(error)}`);
  }
  if (!currentResolvedStat.isFile()) {
    return indeterminate(surface, reference.path, "resolved rollout target is no longer a regular file");
  }
  if (!sameStat(resolved.stat, currentResolvedStat)) {
    return indeterminate(surface, reference.path, "rollout target was replaced while it was being observed");
  }

  const { first, latest } = rolloutMetadata;
  if (!first || !latest) {
    return indeterminate(surface, resolved.path, "referenced rollout has no session_meta metadata");
  }
  const metadata = [
    ["first", first],
    ["latest", latest],
  ] as const;
  for (const [position, payload] of metadata) {
    if (typeof payload.model_provider !== "string" || !payload.model_provider) {
      return indeterminate(surface, resolved.path, `${position} session_meta has no provider metadata`);
    }
  }
  // A native-only Codex rollout can carry an inconsistent thread id in its
  // session metadata without proving OpenCodex residue. Mixed or routed
  // metadata remains fail-closed below, because accepting that state could
  // hide an interrupted provider transition.
  const nativeOnly = metadata.every(([, payload]) => payload.model_provider === "openai");
  for (const [position, payload] of metadata) {
    if (payload.id !== reference.id && !nativeOnly) {
      return indeterminate(surface, resolved.path, `${position} session_meta does not identify the referenced thread`);
    }
  }
  if (!rolloutMetadata.hasOpenCodexProvider && rolloutMetadata.providers.size > 1) {
    return indeterminate(surface, resolved.path, "rollout has mixed provider metadata");
  }
  if (!rolloutMetadata.hasOpenCodexProvider
    && reference.provider !== "opencodex"
    && (rolloutMetadata.providers.size !== 1 || !rolloutMetadata.providers.has(reference.provider))) {
    return indeterminate(surface, resolved.path, "referenced rollout provider does not match history provider");
  }
  return rolloutMetadata.hasOpenCodexProvider
    ? { kind: "residue", surface, path: resolved.path }
    : { kind: "clean" };
}

function classifyReferencedRollouts(
  surface: "history" | "history-backup",
  references: RolloutReference[],
): NativeRoutedResidueResult {
  for (const reference of references) {
    const result = classifyReferencedRollout(surface, reference);
    if (result.kind !== "clean") return result;
  }
  return { kind: "clean" };
}

function classifyHistoryDatabase(path: string): NativeRoutedResidueResult {
  const resolved = resolveRegularFile(path);
  if (resolved.kind === "absent") {
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = resolveRegularFile(`${path}${suffix}`);
      if (sidecar.kind !== "absent") {
        const reason = sidecar.kind === "indeterminate"
          ? sidecar.reason
          : "SQLite sidecar exists without its history database";
        return indeterminate("history", `${path}${suffix}`, reason);
      }
    }
    return { kind: "clean" };
  }
  if (resolved.kind === "indeterminate") return indeterminate("history", path, resolved.reason);
  let database: Database | undefined;
  try {
    const uri = pathToFileURL(resolved.path).href + "?immutable=1";
    database = new Database(uri, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
    database.exec("PRAGMA busy_timeout = 100");
    const rows = database.query<{ id: string; rollout_path: string; model_provider: string }, []>(`
      SELECT id, rollout_path, model_provider
      FROM threads
    `).all();
    const references: RolloutReference[] = [];
    for (const row of rows) {
      if (typeof row.id !== "string" || !row.id || typeof row.rollout_path !== "string" || !row.rollout_path) {
        return indeterminate("history", resolved.path, "history row has an unknown rollout reference");
      }
      if (typeof row.model_provider !== "string" || !row.model_provider) {
        return indeterminate("history", resolved.path, "history row has no provider metadata");
      }
      if (!isKnownRolloutProvider(row.model_provider)) {
        return indeterminate("history", resolved.path, "history row has unknown provider metadata");
      }
      references.push({ id: row.id, path: row.rollout_path, provider: row.model_provider });
    }
    const rollouts = classifyReferencedRollouts("history", references);
    if (rollouts.kind !== "clean") return rollouts;
    const after = statSync(resolved.path);
    if (!sameStat(resolved.stat, after)) {
      return indeterminate("history", resolved.path, "history database changed while it was being observed");
    }
    return rows.some(row => row.model_provider === "opencodex")
      ? { kind: "residue", surface: "history", path: resolved.path }
      : { kind: "clean" };
  } catch (error) {
    return indeterminate("history", resolved.path, `unreadable history database: ${errorReason(error)}`);
  } finally {
    try { database?.close(); } catch { /* the observation already failed closed */ }
  }
}

function historyBackupPath(stateDatabasePath: string): string {
  const normalized = process.platform === "win32"
    ? resolve(stateDatabasePath).toLowerCase()
    : resolve(stateDatabasePath);
  const id = createHash("sha256").update(normalized).digest("hex").slice(0, 16);
  return join(getConfigDir(), `codex-history-backup-${id}.json`);
}

function classifyHistoryBackup(path: string, stateDatabasePath: string): NativeRoutedResidueResult {
  const read = readRegularFile(path);
  if (read.kind === "absent") return { kind: "clean" };
  if (read.kind === "indeterminate") return indeterminate("history-backup", path, read.reason);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.content);
  } catch (error) {
    return indeterminate("history-backup", read.path, `malformed history backup JSON: ${errorReason(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return indeterminate("history-backup", read.path, "history backup has an unknown shape");
  }
  const manifest = parsed as Record<string, unknown>;
  if (manifest.version !== 1 || !manifest.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries)) {
    return indeterminate("history-backup", read.path, "history backup has an unknown shape");
  }
  if (typeof manifest.stateDbPath === "string") {
    const expected = process.platform === "win32" ? resolve(stateDatabasePath).toLowerCase() : resolve(stateDatabasePath);
    const actual = process.platform === "win32" ? resolve(manifest.stateDbPath).toLowerCase() : resolve(manifest.stateDbPath);
    if (actual !== expected) {
      return indeterminate("history-backup", read.path, "history backup names a different state database");
    }
  }
  const entries = Object.values(manifest.entries as Record<string, unknown>);
  const references: RolloutReference[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return indeterminate("history-backup", read.path, "history backup entry has an unknown shape");
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || !candidate.id
      || typeof candidate.rolloutPath !== "string" || !candidate.rolloutPath) {
      return indeterminate("history-backup", read.path, "history backup entry has an unknown rollout reference");
    }
    if (typeof candidate.modelProvider !== "string" || !candidate.modelProvider) {
      return indeterminate("history-backup", read.path, "history backup entry has no provider metadata");
    }
    if (!isKnownRolloutProvider(candidate.modelProvider)) {
      return indeterminate("history-backup", read.path, "history backup entry has unknown provider metadata");
    }
    references.push({ id: candidate.id, path: candidate.rolloutPath, provider: candidate.modelProvider });
  }
  const rollouts = classifyReferencedRollouts("history-backup", references);
  if (rollouts.kind !== "clean") return rollouts;
  return entries.length > 0
    ? { kind: "residue", surface: "history-backup", path: read.path }
    : { kind: "clean" };
}

/** Read-only, fail-closed observation of every OpenCodex-routed Codex surface. */
export function classifyNativeRoutedResidue(): NativeRoutedResidueResult {
  let codexHome: string;
  try {
    codexHome = getCodexHome();
  } catch (error) {
    const unresolved = process.env.CODEX_HOME?.trim() || "CODEX_HOME";
    return indeterminate("partial-write", unresolved, `CODEX_HOME cannot be resolved: ${errorReason(error)}`);
  }

  const configPath = join(codexHome, CONFIG_FILE_NAME);
  let stateDatabasePath: string;
  try {
    stateDatabasePath = resolveCodexStateDbPath({ codexHome });
  } catch (error) {
    // Residue classification is a total, read-only safety boundary. An
    // indeterminate SQLite authority must refuse coordination without escaping
    // as an exception or falling through to a different state database.
    return indeterminate(
      "config",
      configPath,
      `SQLite home cannot be resolved: ${errorReason(error)}`,
    );
  }
  const profilePath = join(codexHome, PROFILE_FILE_NAME);
  const modelsCachePath = join(codexHome, MODELS_CACHE_FILE_NAME);
  const journalPath = join(codexHome, JOURNAL_FILE_NAME);
  const config = inspectConfig(codexHome, configPath);
  const atomicWriteTargets = [
    configPath,
    profilePath,
    modelsCachePath,
    journalPath,
    ...config.catalogTargets.map(target => target.path),
  ];
  const classifiers = [
    () => classifyPartialWrites(atomicWriteTargets),
    () => config.classification,
    () => classifyProfile(profilePath),
    ...config.catalogTargets.map(target => () => classifyCatalogLike("catalog", target.path, target.configured)),
    () => classifyCatalogLike("models-cache", modelsCachePath),
    () => classifyJournal(journalPath),
    () => classifyHistoryDatabase(stateDatabasePath),
    () => classifyHistoryBackup(historyBackupPath(stateDatabasePath), stateDatabasePath),
  ];
  const results = classifiers.map(classify => classify());
  return results.find(result => result.kind === "indeterminate")
    ?? results.find(result => result.kind === "residue")
    ?? { kind: "clean" };
}
