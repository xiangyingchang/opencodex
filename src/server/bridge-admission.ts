import { timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

export const SPLIT_BRIDGE_ADMISSION_HEADER = "x-opencodex-bridge-admission";
export const SPLIT_BRIDGE_ACCOUNT_SELECTOR_HEADER = "x-opencodex-bridge-account-selector";
export const SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV = "OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE";

export type SplitBridgeTrafficBranch = "native" | "gateway";

function secretEquals(actual: string, expected: string): boolean {
  const actualBytes = new TextEncoder().encode(actual);
  const expectedBytes = new TextEncoder().encode(expected);
  return actualBytes.length === expectedBytes.length
    && expectedBytes.length > 0
    && timingSafeEqual(actualBytes, expectedBytes);
}

/** Read the owner-only file used by both halves of an activated split bridge. */
export function readSplitBridgeAdmissionToken(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("split bridge admission token file must be a regular owner-only file");
  if ((stat.mode & 0o077) !== 0) throw new Error("split bridge admission token file must not be group/world accessible");
  const token = readFileSync(path, "utf8").trim();
  if (!token) throw new Error("split bridge admission token file is empty");
  return token;
}

/** True only when the request carries the exact token configured for split mode. */
export function hasSplitBridgeAdmission(request: Request, expectedToken: string | undefined): boolean {
  if (!expectedToken) return false;
  const presented = request.headers.get(SPLIT_BRIDGE_ADMISSION_HEADER)?.trim() ?? "";
  return secretEquals(presented, expectedToken);
}

/** Return a logical branch only after the bridge token has been verified. */
export function splitBridgeTrafficBranch(
  request: Request,
  expectedToken: string | undefined,
): SplitBridgeTrafficBranch | null {
  if (!hasSplitBridgeAdmission(request, expectedToken)) return null;
  const accountSelector = request.headers.get(SPLIT_BRIDGE_ACCOUNT_SELECTOR_HEADER)?.trim();
  return accountSelector ? "native" : "gateway";
}
