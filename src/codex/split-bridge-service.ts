import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config";
import { runLaunchctl } from "../service";
import { readSplitBridgeAdmissionToken } from "../server/bridge-admission";
import {
  buildSplitBridgeLaunchAgentPlist,
  configuredSplitBridgeLaunchAgentOptions,
  splitBridgeLaunchAgentDigest,
  splitBridgeLaunchAgentOptionsFromPlist,
  splitBridgeLaunchAgentPath,
  type SplitBridgeLaunchAgentOptions,
} from "./split-bridge-launchd";

export type SplitBridgeServiceAction = "install" | "load" | "status" | "stop" | "uninstall" | "repair";

export interface SplitBridgeServiceDeps {
  readonly home?: string;
  readonly configDir?: string;
  readonly launchctl?: typeof runLaunchctl;
  readonly launchAgentOptions?: SplitBridgeLaunchAgentOptions;
}

export interface SplitBridgeServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly matchesPlist: boolean;
  readonly pid: number | null;
  readonly plistPath: string;
}

function launchdGuiDomain(): string {
  return "gui/" + (process.getuid?.() ?? 0);
}

function servicePaths(deps: SplitBridgeServiceDeps): { plistPath: string; configDir: string } {
  const home = deps.home ?? homedir();
  const configDir = deps.configDir ?? getConfigDir();
  return { plistPath: splitBridgeLaunchAgentPath(home), configDir };
}

function commandResult(run: typeof runLaunchctl, args: string[]): ReturnType<typeof runLaunchctl> {
  return run(args);
}

function loadedFromPlist(run: typeof runLaunchctl, plistPath: string): boolean {
  const result = commandResult(run, ["print", launchdGuiDomain() + "/com.opencodex.split-bridge"]);
  return result.ok && `${result.stdout}\n${result.stderr}`.includes(`path = ${plistPath}`);
}

function bootstrap(run: typeof runLaunchctl, plistPath: string): void {
  const result = commandResult(run, ["bootstrap", launchdGuiDomain(), plistPath]);
  // launchctl can return status 5 after it has already registered the job. This
  // is common during a bootout/bootstrap replacement on macOS: treating the raw
  // exit code as authoritative makes repair report failure while the process is
  // actually running. Confirm the postcondition before rolling back.
  if (!result.ok && !waitForLoadedFromPlist(run, plistPath)) {
    throw new Error("launchctl could not bootstrap split bridge: " + (result.stderr || "operation failed"));
  }
}

function bootout(run: typeof runLaunchctl): void {
  const result = commandResult(run, ["bootout", launchdGuiDomain() + "/com.opencodex.split-bridge"]);
  if (!result.ok && result.status !== 3 && result.status !== 112 && result.status !== 113) {
    throw new Error("launchctl could not stop split bridge: " + (result.stderr || "operation failed"));
  }
  if (!waitForUnloaded(run)) {
    throw new Error("launchctl did not finish stopping split bridge before replacement");
  }
}

let plistWriteSequence = 0;
const BOOTSTRAP_CONFIRM_ATTEMPTS = 20;
const BOOTSTRAP_CONFIRM_DELAY_MS = 100;
const BOOTOUT_SETTLE_ATTEMPTS = 20;
const BOOTOUT_SETTLE_DELAY_MS = 100;

function waitForLoadedFromPlist(run: typeof runLaunchctl, plistPath: string): boolean {
  for (let attempt = 0; attempt < BOOTSTRAP_CONFIRM_ATTEMPTS; attempt += 1) {
    if (loadedFromPlist(run, plistPath)) return true;
    if (attempt + 1 < BOOTSTRAP_CONFIRM_ATTEMPTS) Bun.sleepSync(BOOTSTRAP_CONFIRM_DELAY_MS);
  }
  return false;
}

function waitForUnloaded(run: typeof runLaunchctl): boolean {
  for (let attempt = 0; attempt < BOOTOUT_SETTLE_ATTEMPTS; attempt += 1) {
    const result = commandResult(run, ["print", launchdGuiDomain() + "/com.opencodex.split-bridge"]);
    if (!result.ok && (result.status === 3 || result.status === 112 || result.status === 113)) return true;
    if (attempt + 1 < BOOTOUT_SETTLE_ATTEMPTS) Bun.sleepSync(BOOTOUT_SETTLE_DELAY_MS);
  }
  return false;
}

function writePlistAtomically(plistPath: string, content: string): void {
  const tempPath = `${plistPath}.ocx.${process.pid}.${++plistWriteSequence}.tmp`;
  try {
    writeFileSync(tempPath, content, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(tempPath, 0o600); } catch { /* best effort */ }
    renameSync(tempPath, plistPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function plistMatchesContract(
  plistPath: string,
  expectedOptions?: SplitBridgeLaunchAgentOptions,
): boolean {
  let content: string;
  try {
    content = readFileSync(plistPath, "utf8");
  } catch {
    return false;
  }
  if (expectedOptions) {
    try {
      return content === buildSplitBridgeLaunchAgentPlist(expectedOptions);
    } catch {
      return false;
    }
  }
  // Status normally runs outside launchd's plist environment. In that case prove the
  // installed file is a complete bridge plist rather than treating its path as proof.
  return content.includes(`<key>Label</key><string>com.opencodex.split-bridge</string>`)
    && content.includes("<key>ProgramArguments</key>")
    && content.includes("<string>split-bridge</string>")
    && content.includes("<string>start</string>")
    && (() => {
      const digest = /<string>--split-plist-digest=([a-f0-9]{64})<\/string>/.exec(content)?.[1];
      return digest !== undefined;
    })()
    && content.includes("<key>OCX_SPLIT_NATIVE_BASE_URL</key>")
    && content.includes("<key>OCX_SPLIT_GATEWAY_BASE_URL</key>")
    && content.includes("<key>OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE</key>")
    && content.includes("<key>StandardOutPath</key>")
    && content.includes("<key>StandardErrorPath</key>");
}

function plistDigestFromContent(content: string): string | null {
  return /<string>--split-plist-digest=([a-f0-9]{64})<\/string>/.exec(content)?.[1] ?? null;
}

export function splitBridgeServiceStatus(deps: SplitBridgeServiceDeps = {}): SplitBridgeServiceStatus {
  const { plistPath } = servicePaths(deps);
  if (process.platform !== "darwin") {
    return { supported: false, installed: false, loaded: false, matchesPlist: false, pid: null, plistPath };
  }
  const run = deps.launchctl ?? runLaunchctl;
  const printed = commandResult(run, ["print", launchdGuiDomain() + "/com.opencodex.split-bridge"]);
  const printedText = `${printed.stdout}\n${printed.stderr}`;
  const pidMatch = /\bpid\s*=\s*(\d+)/i.exec(printedText);
  let installedPlist: string | null = null;
  try { installedPlist = readFileSync(plistPath, "utf8"); } catch { /* status below is false */ }
  const installedOptions = installedPlist ? splitBridgeLaunchAgentOptionsFromPlist(installedPlist) : null;
  const embeddedDigest = installedPlist ? plistDigestFromContent(installedPlist) : null;
  const expectedDigest = deps.launchAgentOptions
    ? splitBridgeLaunchAgentDigest(deps.launchAgentOptions)
    : installedOptions ? splitBridgeLaunchAgentDigest(installedOptions) : null;
  const loadedDigestMatches = expectedDigest !== null && printedText.includes(expectedDigest);
  const plistDigestMatches = expectedDigest !== null && embeddedDigest === expectedDigest;
  const plistMatches = plistMatchesContract(plistPath, deps.launchAgentOptions)
    && plistDigestMatches
    && loadedDigestMatches;
  return {
    supported: true,
    installed: existsSync(plistPath),
    loaded: printed.ok,
    matchesPlist: printed.ok && printedText.includes(plistPath) && plistMatches,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    plistPath,
  };
}

export function installSplitBridgeService(deps: SplitBridgeServiceDeps = {}): SplitBridgeServiceStatus {
  if (process.platform !== "darwin") throw new Error("split bridge LaunchAgent lifecycle is only supported on macOS");
  const { plistPath, configDir } = servicePaths(deps);
  const run = deps.launchctl ?? runLaunchctl;
   const options = deps.launchAgentOptions ?? configuredSplitBridgeLaunchAgentOptions(configDir);
  readSplitBridgeAdmissionToken(options.admissionTokenFile);
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
  if (!existsSync(dirname(plistPath))) mkdirSync(dirname(plistPath), { recursive: true, mode: 0o700 });
  const nextPlist = buildSplitBridgeLaunchAgentPlist(options);
  const previousPlist = existsSync(plistPath) ? readFileSync(plistPath, "utf8") : null;
  const previousLoaded = splitBridgeServiceStatus({ ...deps, launchctl: run }).loaded;
  writePlistAtomically(plistPath, nextPlist);
  try {
    bootout(run);
    bootstrap(run, plistPath);
    const status = splitBridgeServiceStatus({ ...deps, launchctl: run });
    if (!status.loaded || !status.matchesPlist) {
      throw new Error("split bridge LaunchAgent did not remain loaded from the current plist");
    }
    return status;
  } catch (error) {
    // Replacing a loaded job is a transaction: restore both the file and the
    // previous loaded state when the new bootstrap or postcondition fails.
    try { bootout(run); } catch { /* best effort before rollback */ }
    try {
      if (previousPlist === null) {
        if (existsSync(plistPath)) unlinkSync(plistPath);
      } else {
        writePlistAtomically(plistPath, previousPlist);
        if (previousLoaded) bootstrap(run, plistPath);
      }
    } catch (rollbackError) {
      throw new Error(
        `split bridge LaunchAgent replacement failed and rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function loadSplitBridgeService(deps: SplitBridgeServiceDeps = {}): SplitBridgeServiceStatus {
  if (process.platform !== "darwin") throw new Error("split bridge LaunchAgent lifecycle is only supported on macOS");
  const { plistPath } = servicePaths(deps);
  if (!existsSync(plistPath)) throw new Error("split bridge LaunchAgent is not installed: " + plistPath);
  const run = deps.launchctl ?? runLaunchctl;
  const current = splitBridgeServiceStatus({ ...deps, launchctl: run });
  if (!current.loaded || !current.matchesPlist) {
    if (current.loaded) bootout(run);
    bootstrap(run, plistPath);
  }
  return splitBridgeServiceStatus({ ...deps, launchctl: run });
}

export function stopSplitBridgeService(deps: SplitBridgeServiceDeps = {}): SplitBridgeServiceStatus {
  if (process.platform !== "darwin") throw new Error("split bridge LaunchAgent lifecycle is only supported on macOS");
  const run = deps.launchctl ?? runLaunchctl;
  bootout(run);
  return splitBridgeServiceStatus({ ...deps, launchctl: run });
}

export function uninstallSplitBridgeService(deps: SplitBridgeServiceDeps = {}): SplitBridgeServiceStatus {
  if (process.platform !== "darwin") throw new Error("split bridge LaunchAgent lifecycle is only supported on macOS");
  const { plistPath } = servicePaths(deps);
  const run = deps.launchctl ?? runLaunchctl;
  bootout(run);
  if (existsSync(plistPath)) unlinkSync(plistPath);
  return splitBridgeServiceStatus({ ...deps, launchctl: run });
}

export function repairSplitBridgeService(deps: SplitBridgeServiceDeps = {}): SplitBridgeServiceStatus {
  return installSplitBridgeService(deps);
}
