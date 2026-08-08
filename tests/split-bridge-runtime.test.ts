import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  readSplitBridgeAdmissionToken,
  resolveSplitBridgeEnvironment,
  SPLIT_BRIDGE_GATEWAY_BASE_URL,
  SPLIT_BRIDGE_NATIVE_BASE_URL_ENV,
  SPLIT_BRIDGE_GATEWAY_BASE_URL_ENV,
  SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV,
} from "../src/codex/split-bridge-runtime";
import {
  buildSplitBridgeLaunchAgentPlist,
  splitBridgeLaunchAgentPath,
  SPLIT_BRIDGE_LAUNCHD_LABEL,
} from "../src/codex/split-bridge-launchd";

describe("split bridge runtime contract", () => {
  test("requires an explicit native endpoint and admission-token file", () => {
    expect(() => resolveSplitBridgeEnvironment({ env: {} })).toThrow(SPLIT_BRIDGE_NATIVE_BASE_URL_ENV);
    expect(() => resolveSplitBridgeEnvironment({
      env: { [SPLIT_BRIDGE_NATIVE_BASE_URL_ENV]: "https://api.openai.example/v1" },
    })).toThrow(SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV);
  });

  test("uses the isolated 10100 gateway only as the default third-party target", () => {
    const result = resolveSplitBridgeEnvironment({
      env: {
        [SPLIT_BRIDGE_NATIVE_BASE_URL_ENV]: "https://api.openai.example/v1",
        [SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV]: "/tmp/split-admission-token",
      },
    });
    expect(result.gatewayBaseUrl).toBe(SPLIT_BRIDGE_GATEWAY_BASE_URL);
    expect(result.admissionTokenFile).toBe("/tmp/split-admission-token");
  });

  test("allows an explicit gateway endpoint without embedding credentials", () => {
    const result = resolveSplitBridgeEnvironment({
      env: {
        [SPLIT_BRIDGE_NATIVE_BASE_URL_ENV]: "https://api.openai.example/v1",
        [SPLIT_BRIDGE_GATEWAY_BASE_URL_ENV]: "http://127.0.0.1:10100/v1",
        [SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV]: "/tmp/split-admission-token",
      },
    });
    expect(result.gatewayBaseUrl).toBe("http://127.0.0.1:10100/v1");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  test("rejects invalid or shared physical targets before startup", () => {
    const base = {
      [SPLIT_BRIDGE_NATIVE_BASE_URL_ENV]: "http://127.0.0.1:10100/v1",
      [SPLIT_BRIDGE_ADMISSION_TOKEN_FILE_ENV]: "/tmp/split-admission-token",
    };
    expect(() => resolveSplitBridgeEnvironment({ env: base })).toThrow("different physical origins");
    expect(() => resolveSplitBridgeEnvironment({
      env: {
        ...base,
        [SPLIT_BRIDGE_NATIVE_BASE_URL_ENV]: "https://api.openai.example/v1?query-not-allowed",
      },
    })).toThrow("only an HTTP(S) origin and path prefix");
  });

  test("requires owner-only permissions for the admission token file", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-split-token-"));
    const tokenPath = join(root, "admission-token");
    try {
      writeFileSync(tokenPath, "[REDACTED]\n", { mode: 0o600 });
      chmodSync(tokenPath, 0o600);
      expect(readSplitBridgeAdmissionToken(tokenPath)).toBe("[REDACTED]");
      chmodSync(tokenPath, 0o644);
      expect(() => readSplitBridgeAdmissionToken(tokenPath)).toThrow("group/world accessible");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("split bridge launchd contract", () => {
  test("builds an independent 10101 LaunchAgent without embedding the admission secret", () => {
    const plist = buildSplitBridgeLaunchAgentPlist({
      bunPath: "/opt/bun",
      cliPath: "/opt/opencodex/src/cli/index.ts",
      nativeBaseUrl: "https://api.openai.example/v1",
      gatewayBaseUrl: "http://127.0.0.1:10100/v1",
      admissionTokenFile: "/Users/test/.opencodex/split-admission-token",
      standardOutPath: "/Users/test/.opencodex/split-bridge.log",
      standardErrorPath: "/Users/test/.opencodex/split-bridge.log",
    });

    expect(plist).toContain(`<string>${SPLIT_BRIDGE_LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<string>split-bridge</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<key>OCX_SPLIT_NATIVE_BASE_URL</key>");
    expect(plist).toContain("<key>OCX_SPLIT_GATEWAY_BASE_URL</key>");
    expect(plist).toContain("<key>OCX_SPLIT_GATEWAY_ADMISSION_TOKEN_FILE</key>");
    expect(plist).toContain("split-admission-token");
    expect(plist).not.toContain("gateway-admission-secret");
    expect(splitBridgeLaunchAgentPath("/Users/test")).toBe(
      "/Users/test/Library/LaunchAgents/com.opencodex.split-bridge.plist",
    );
  });
});
