import type { Server } from "bun";
import { resolve } from "node:path";
import { getConfigDir, loadConfig } from "../config";
import { visibleCodexAccountSelectors } from "./catalog/account-models";
import { readCatalog, readCodexCatalogPath } from "./catalog/parsing";
import { buildProviderSplitCatalog } from "./split-catalog";
import { startSplitBridge, assertSplitBridgeTargetUrls, type StartSplitBridgeOptions } from "../split-bridge";
import type { OcxConfig } from "../types";
import {
  configuredSplitBridgeLaunchAgentOptions,
  splitBridgeLaunchAgentDigest,
} from "./split-bridge-launchd";
import {
  readSplitBridgeAdmissionToken as readSplitBridgeAdmissionTokenFromFile,
  SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV,
} from "../server/bridge-admission";

export const SPLIT_BRIDGE_PORT = 10101;
export const SPLIT_BRIDGE_GATEWAY_BASE_URL = "http://127.0.0.1:10100/v1";
export const SPLIT_BRIDGE_NATIVE_BASE_URL_ENV = "OCX_SPLIT_NATIVE_BASE_URL";
export const SPLIT_BRIDGE_GATEWAY_BASE_URL_ENV = "OCX_SPLIT_GATEWAY_BASE_URL";
export { SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV } from "../server/bridge-admission";

export interface SplitBridgeEnvironment {
  readonly nativeBaseUrl: string;
  readonly gatewayBaseUrl: string;
  readonly admissionTokenFile: string;
}

export interface SplitBridgeRuntimeDeps {
  readonly env?: Record<string, string | undefined>;
  readonly readTokenFile?: (path: string) => string;
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required to start the split bridge`);
  return value;
}

/** Resolve non-secret runtime inputs without reading config or mutating the machine. */
export function resolveSplitBridgeEnvironment(
  deps: SplitBridgeRuntimeDeps = {},
): SplitBridgeEnvironment {
  const env = deps.env ?? process.env;
  const nativeBaseUrl = requiredEnv(env, SPLIT_BRIDGE_NATIVE_BASE_URL_ENV);
  const gatewayBaseUrl = env[SPLIT_BRIDGE_GATEWAY_BASE_URL_ENV]?.trim() || SPLIT_BRIDGE_GATEWAY_BASE_URL;
  assertSplitBridgeTargetUrls(nativeBaseUrl, gatewayBaseUrl);
  return {
    nativeBaseUrl,
    gatewayBaseUrl,
    admissionTokenFile: resolve(requiredEnv(env, SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV)),
  };
}

export function readSplitBridgeAdmissionToken(path: string): string {
  return readSplitBridgeAdmissionTokenFromFile(path);
}

function splitCatalog(config: OcxConfig) {
  const catalog = readCatalog(readCodexCatalogPath());
  if (!catalog?.models) {
    throw new Error("Codex split catalog is missing or unreadable; run `ocx sync` before starting the split bridge");
  }
  return buildProviderSplitCatalog({
    entries: catalog.models,
    officialAccountNamespaces: visibleCodexAccountSelectors(config),
    disabledModels: config.disabledModels,
  });
}

export function buildConfiguredSplitBridgeOptions(
  deps: SplitBridgeRuntimeDeps = {},
): StartSplitBridgeOptions {
  const environment = resolveSplitBridgeEnvironment(deps);
  const config = loadConfig();
  const readTokenFile = deps.readTokenFile ?? readSplitBridgeAdmissionToken;
  const options: StartSplitBridgeOptions = {
    catalog: splitCatalog(config),
    nativeBaseUrl: environment.nativeBaseUrl,
    gatewayBaseUrl: environment.gatewayBaseUrl,
    gatewayAdmissionToken: readTokenFile(environment.admissionTokenFile),
    hostname: "127.0.0.1",
    port: SPLIT_BRIDGE_PORT,
  };
  return options;
}

/** Foreground process entry used by the dedicated LaunchAgent. */
export async function runConfiguredSplitBridge(expectedPlistDigest?: string): Promise<never> {
  const managedByLaunchAgent = process.env.OCX_SPLIT_BRIDGE === "1";
  if (managedByLaunchAgent && !expectedPlistDigest) {
    throw new Error("split bridge LaunchAgent digest is missing; run `ocx split-bridge repair`");
  }
  if (expectedPlistDigest) {
    const actualPlistDigest = splitBridgeLaunchAgentDigest(
      configuredSplitBridgeLaunchAgentOptions(getConfigDir()),
    );
    if (expectedPlistDigest !== actualPlistDigest) {
      throw new Error("split bridge LaunchAgent digest does not match its configured endpoints; run `ocx split-bridge repair`");
    }
  }
  const server: Server<undefined> = startSplitBridge(buildConfiguredSplitBridgeOptions());
  console.log(`Split bridge listening on 127.0.0.1:${server.port}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      server.stop();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  process.exit(0);
}
