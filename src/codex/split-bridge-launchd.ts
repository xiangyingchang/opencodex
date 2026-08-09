import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { durableBunRuntime } from "../lib/bun-runtime";
import { assertSplitBridgeTargetUrls } from "../split-bridge";

export const SPLIT_BRIDGE_LAUNCHD_LABEL = "com.opencodex.split-bridge";

export interface SplitBridgeLaunchAgentOptions {
  readonly bunPath: string;
  readonly cliPath: string;
  readonly nativeBaseUrl: string;
  readonly gatewayBaseUrl?: string;
  readonly admissionTokenFile: string;
  readonly standardOutPath: string;
  readonly standardErrorPath: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for split bridge lifecycle operations`);
  return value;
}

export function configuredSplitBridgeLaunchAgentOptions(configDir: string = getConfigDir()): SplitBridgeLaunchAgentOptions {
  const runtime = durableBunRuntime();
  const cliPath = join(import.meta.dir, "..", "cli", "index.ts");
  return {
    bunPath: runtime.path,
    cliPath,
    nativeBaseUrl: requiredEnvironment("OCX_SPLIT_NATIVE_BASE_URL"),
    gatewayBaseUrl: process.env.OCX_SPLIT_GATEWAY_BASE_URL?.trim(),
    admissionTokenFile: resolve(requiredEnvironment("OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE")),
    standardOutPath: join(configDir, "split-bridge.log"),
    standardErrorPath: join(configDir, "split-bridge.error.log"),
  };
}

function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function splitBridgeLaunchAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${SPLIT_BRIDGE_LAUNCHD_LABEL}.plist`);
}

function decodePlistString(value: string): string {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

export function splitBridgeLaunchAgentDigest(options: SplitBridgeLaunchAgentOptions): string {
  return createHash("sha256")
    .update(JSON.stringify({
      bunPath: options.bunPath,
      cliPath: options.cliPath,
      nativeBaseUrl: options.nativeBaseUrl,
      gatewayBaseUrl: options.gatewayBaseUrl ?? "http://127.0.0.1:10100/v1",
      admissionTokenFile: options.admissionTokenFile,
      standardOutPath: options.standardOutPath,
      standardErrorPath: options.standardErrorPath,
    }), "utf8")
    .digest("hex");
}

function plistStringValue(plist: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match?.[1] === undefined ? null : decodePlistString(match[1]);
}

function plistStringArray(plist: string, key: string): string[] | null {
  const section = new RegExp(`<key>${key}</key>\\s*<array>([\\s\\S]*?)</array>`).exec(plist)?.[1];
  if (section === undefined) return null;
  return [...section.matchAll(/<string>([^<]*)</g)].map(match => decodePlistString(match[1] ?? ""));
}

/** Parse the values covered by the LaunchAgent digest without reading the token itself. */
export function splitBridgeLaunchAgentOptionsFromPlist(plist: string): SplitBridgeLaunchAgentOptions | null {
  const args = plistStringArray(plist, "ProgramArguments");
  const nativeBaseUrl = plistStringValue(plist, "OCX_SPLIT_NATIVE_BASE_URL");
  const gatewayBaseUrl = plistStringValue(plist, "OCX_SPLIT_GATEWAY_BASE_URL");
  const admissionTokenFile = plistStringValue(plist, "OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE");
  const standardOutPath = plistStringValue(plist, "StandardOutPath");
  const standardErrorPath = plistStringValue(plist, "StandardErrorPath");
  if (!args || args.length < 5
    || args[2] !== "split-bridge"
    || args[3] !== "start"
    || !nativeBaseUrl
    || !gatewayBaseUrl
    || !admissionTokenFile
    || !standardOutPath
    || !standardErrorPath) return null;
  return {
    bunPath: args[0]!,
    cliPath: args[1]!,
    nativeBaseUrl,
    gatewayBaseUrl,
    admissionTokenFile,
    standardOutPath,
    standardErrorPath,
  };
}

/** Extract only the token file path from a generated plist; never reads the token. */
export function splitBridgeAdmissionTokenPathFromPlist(plist: string): string | null {
  const path = plistStringValue(plist, "OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE")?.trim() ?? "";
  return path || null;
}

export function installedSplitBridgeAdmissionTokenPath(home = homedir()): string | null {
  const path = splitBridgeLaunchAgentPath(home);
  if (!existsSync(path)) return null;
  try {
    return splitBridgeAdmissionTokenPathFromPlist(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Pure plist builder. It carries a token file path, never the token value. */
export function buildSplitBridgeLaunchAgentPlist(options: SplitBridgeLaunchAgentOptions): string {
  const gatewayBaseUrl = options.gatewayBaseUrl ?? "http://127.0.0.1:10100/v1";
  if (!isAbsolute(options.admissionTokenFile)) throw new TypeError("admissionTokenFile must be an absolute path");
  assertSplitBridgeTargetUrls(options.nativeBaseUrl, gatewayBaseUrl);
  const args = [
    options.bunPath,
    options.cliPath,
    "split-bridge",
    "start",
    `--split-plist-digest=${splitBridgeLaunchAgentDigest(options)}`,
  ];
  const argsXml = args.map(value => `    <string>${plistString(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${plistString(SPLIT_BRIDGE_LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCX_SPLIT_BRIDGE</key><string>1</string>
    <key>OCX_SPLIT_NATIVE_BASE_URL</key><string>${plistString(options.nativeBaseUrl)}</string>
    <key>OCX_SPLIT_GATEWAY_BASE_URL</key><string>${plistString(gatewayBaseUrl)}</string>
    <key>OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE</key><string>${plistString(options.admissionTokenFile)}</string>
  </dict>
  <key>StandardOutPath</key><string>${plistString(options.standardOutPath)}</string>
  <key>StandardErrorPath</key><string>${plistString(options.standardErrorPath)}</string>
</dict>
</plist>
`;
}
