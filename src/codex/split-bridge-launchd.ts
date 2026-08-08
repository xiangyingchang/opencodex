import { homedir } from "node:os";
import { join } from "node:path";
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

/** Pure plist builder. It carries a token file path, never the token value. */
export function buildSplitBridgeLaunchAgentPlist(options: SplitBridgeLaunchAgentOptions): string {
  const gatewayBaseUrl = options.gatewayBaseUrl ?? "http://127.0.0.1:10100/v1";
  assertSplitBridgeTargetUrls(options.nativeBaseUrl, gatewayBaseUrl);
  const args = [options.bunPath, options.cliPath, "split-bridge", "start"];
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
