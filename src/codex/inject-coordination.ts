/**
 * Coordination helpers for the native Codex write section.
 *
 * Split out of `inject.ts` so the injection function keeps reading as the
 * sequence it is, rather than doubling in length around the lock.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFile } from "../config";
import type { CodexWriteLockResult } from "./codex-write-lock";
import { JOURNAL_PATH } from "./journal";
import { isUnmarkedProfileResidue } from "./native-residue";
import { CODEX_CONFIG_PATH, CODEX_PROFILE_PATH } from "./paths";
import {
  codexWriteCoordination,
  type CodexWriteCandidate,
  type CodexWriteCoordination,
  type CodexWriteEvidence,
} from "./write-coordination";

/** Bounded so a stuck holder cannot wedge `ocx start` indefinitely. */
export const DEFAULT_INJECT_LOCK_TIMEOUT_MS = 5_000;

/**
 * Can this home be coordinated at all, decided BEFORE any lock attempt?
 *
 * The order matters and is not stylistic. `assertInitialStateCanBeCreated`
 * refuses to create the first coordinator row while native routing residue
 * exists (`transition-state.ts:268-280`) — correctly, because installing
 * `{0,null}` over routed bytes would erase the only evidence that an
 * interrupted transition needs salvage. But "already routed, no coordinator
 * row" is the state of every install predating this substrate, so a "try the
 * lock, fall back on refusal" shape would attempt acquisition on the entire
 * installed base. Deciding first means that refusal path is never entered.
 *
 * `legacy-uncoordinated` is the explicit input to a first-lock residue
 * adoption. The caller still takes N -> C; this result only selects whether
 * the coordinator may initialize over already-routed bytes.
 */
export type CodexWriteCoordinationEligibility =
  | { kind: "coordinated" }
  | { kind: "legacy-uncoordinated"; reason: string }
  | { kind: "refused"; reason: string };

export function codexWriteCoordinationEligibility(deps: {
  coordinatorPath: () => string;
  residue: () => { kind: string; surface?: string; reason?: string };
  integrationRecord: () => { kind: string };
  allowIndeterminateResidue?: boolean;
  allowIndeterminateProfile?: boolean;
}): CodexWriteCoordinationEligibility {
  let coordinatorExists: boolean;
  try {
    coordinatorExists = existsSync(deps.coordinatorPath());
  } catch (error) {
    return { kind: "refused", reason: `the coordinator path could not be resolved: ${String(error)}` };
  }

  // An existing coordinator is authoritative, and the lock owns validating it —
  // including the unversioned and rowless cases it must refuse rather than adopt.
  if (coordinatorExists) return { kind: "coordinated" };

  const record = deps.integrationRecord();
  if (record.kind === "invalid") {
    return { kind: "refused", reason: "the Codex integration record is invalid" };
  }

  const residue = deps.residue();
  if (residue.kind === "clean") return { kind: "coordinated" };
  if (residue.kind === "indeterminate") {
    if (deps.allowIndeterminateProfile && isUnmarkedProfileResidue(residue)) {
      return {
        kind: "legacy-uncoordinated",
        reason: "this valid unmarked Codex profile will be snapshotted before replacement",
      };
    }
    if (deps.allowIndeterminateResidue) {
      return {
        kind: "legacy-uncoordinated",
        reason: "this restore has explicit evidence for adopting an ambiguous pre-substrate state",
      };
    }
    return {
      kind: "refused",
      reason: "the existing native Codex state is ambiguous and cannot seed a coordinator row",
    };
  }
  /*
   * Recognized routed residue keeps the path it has always had.
   *
   * The explicit adoption exception is limited to a recognized pre-substrate
   * routed home. Unknown or unreadable surfaces must remain recoverable instead
   * of being converted into an apparently authoritative empty coordinator row.
   */
  return {
    kind: "legacy-uncoordinated",
    reason: "this home was routed before write coordination existed and has not been adopted yet",
  };
}

/** The transition row rejected this publication; a conflict, not an exception. */
export class CodexWriteConflictError extends Error {
  readonly code = "CODEX_WRITE_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "CodexWriteConflictError";
  }
}

/**
 * A write failed AND its compensation failed.
 *
 * Carries which surfaces are unrestored, never their contents — this reaches
 * logs and HTTP responses, and config bytes carry credentials.
 */
export class CodexPartialWriteError extends Error {
  readonly code = "CODEX_PARTIAL_WRITE";
  constructor(readonly unrestored: readonly string[]) {
    super(`Native Codex files are in a partial state; unrestored: ${unrestored.join(", ")}.`);
    this.name = "CodexPartialWriteError";
  }
}

function contentIdentity(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 32);
  } catch {
    return existsSync(path) ? "unreadable" : "absent";
  }
}

export interface CodexPreImages {
  readonly config: string | null;
  readonly profile: string | null;
  readonly journal: string | null;
}

/** `null` means the file was ABSENT, which restoration must reproduce exactly. */
function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

export function captureCodexPreImages(): CodexPreImages {
  return {
    config: readOrNull(CODEX_CONFIG_PATH),
    profile: readOrNull(CODEX_PROFILE_PATH),
    journal: readOrNull(JOURNAL_PATH),
  };
}

/**
 * Put back exactly what was there, and report honestly when that fails.
 *
 * Every surface is attempted even after one fails: a second failure is worth
 * knowing about, and stopping early would leave more unrestored than necessary.
 */
export function restoreCodexPreImages(
  pre: CodexPreImages,
): { complete: boolean; unrestored: readonly string[] } {
  const unrestored: string[] = [];
  const surfaces: readonly [string, string, string | null][] = [
    ["config", CODEX_CONFIG_PATH, pre.config],
    ["profile", CODEX_PROFILE_PATH, pre.profile],
    ["journal", JOURNAL_PATH, pre.journal],
  ];
  for (const [name, path, bytes] of surfaces) {
    try {
      if (bytes === null) {
        // Absent before, so absent after. A leftover file is not a restoration.
        if (existsSync(path)) require("node:fs").unlinkSync(path);
      } else if (readOrNull(path) !== bytes) {
        atomicWriteFile(path, bytes);
      }
    } catch {
      unrestored.push(name);
    }
  }
  return { complete: unrestored.length === 0, unrestored };
}

export function buildInjectWitness(
  candidate: CodexWriteCandidate,
  nativeInput: string,
  persistedIdentity: string,
  generation: CodexWriteEvidence["generation"],
  observedOwnership: CodexWriteCoordination["observedOwnership"],
): CodexWriteCoordination {
  return codexWriteCoordination(
    candidate,
    {
      nativeInputIdentity: createHash("sha256").update(nativeInput).digest("hex"),
      persistedIdentity,
      generation,
      journalIdentity: contentIdentity(JOURNAL_PATH),
      canonicalTargets: {
        config: CODEX_CONFIG_PATH,
        profile: CODEX_PROFILE_PATH,
        journal: JOURNAL_PATH,
      },
    },
    observedOwnership,
  );
}

/**
 * The under-lock re-read.
 *
 * The candidate bytes are fixed — they were computed before acquisition and do
 * not change — so what is re-read is the EVIDENCE: the native input on disk, the
 * journal, the generation from the open transaction. A comparison that copied
 * those forward would match itself and prove nothing.
 */
export function recomputeInjectWitness(options: {
  candidate: CodexWriteCandidate;
  canonicalTargets: CodexWriteEvidence["canonicalTargets"];
  persistedIdentity: string;
  generation: CodexWriteEvidence["generation"];
  observedOwnership: CodexWriteCoordination["observedOwnership"];
  /** Restore uses a combined config/profile snapshot; injection keeps the default config read. */
  nativeInput?: string;
}): CodexWriteCoordination {
  const nativeInput = options.nativeInput ?? readOrNull(options.canonicalTargets.config) ?? "";
  return codexWriteCoordination(
    options.candidate,
    {
      nativeInputIdentity: createHash("sha256").update(nativeInput).digest("hex"),
      persistedIdentity: options.persistedIdentity,
      generation: options.generation,
      journalIdentity: contentIdentity(options.canonicalTargets.journal),
      canonicalTargets: options.canonicalTargets,
    },
    options.observedOwnership,
  );
}

/** Project a non-acquired lock result into the injection result shape. */
export function codexInjectLockOutcome(
  result: Exclude<CodexWriteLockResult<unknown>, { status: "acquired" }>,
): { success: false; message: string; retryable: boolean } | {
  success: true; status: "skipped"; skippedReason: "desired_disabled" | "desired_enabled"; message: string;
} {
  if (result.status === "skipped") {
    return {
      success: true,
      status: "skipped",
      skippedReason: result.reason,
      message: result.reason === "desired_disabled"
        ? "Codex integration is OFF; no Codex config, catalog, cache, or history was changed."
        : "Codex integration was re-enabled; native restore was skipped.",
    };
  }
  if (result.status === "busy") {
    return {
      success: false,
      retryable: true,
      message: `Another process is writing Codex configuration right now (waited ${result.waitedMs}ms). Retry shortly.`,
    };
  }
  return {
    success: false,
    retryable: false,
    message: `Codex configuration was not written: ${result.message}`,
  };
}
