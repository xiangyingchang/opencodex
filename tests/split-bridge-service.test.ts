import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installSplitBridgeService,
  loadSplitBridgeService,
  repairSplitBridgeService,
  splitBridgeServiceStatus,
  stopSplitBridgeService,
  uninstallSplitBridgeService,
} from "../src/codex/split-bridge-service";
import type { SplitBridgeLaunchAgentOptions } from "../src/codex/split-bridge-launchd";
import {
  splitBridgeAdmissionTokenPathFromPlist,
  splitBridgeLaunchAgentDigest,
  splitBridgeLaunchAgentOptionsFromPlist,
} from "../src/codex/split-bridge-launchd";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

describe("split bridge LaunchAgent lifecycle", () => {
  test("install/load/status/stop/uninstall and repair are independently testable", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-split-service-"));
    let active = false;
    let expectedPlistPath = "";
    const calls: string[][] = [];
    const launchctl = (args: string[]) => {
      calls.push(args);
      if (args[0] === "bootstrap") {
        active = true;
        return { ok: true, stdout: "", stderr: "", status: 0 };
      }
      if (args[0] === "bootout") {
        const wasActive = active;
        active = false;
        return { ok: wasActive, stdout: "", stderr: wasActive ? "" : "not loaded", status: wasActive ? 0 : 3 };
      }
      return active
        ? { ok: true, stdout: `path = ${expectedPlistPath}\npid = 4242\n--split-plist-digest=${splitBridgeLaunchAgentDigest(options)}`, stderr: "", status: 0 }
        : { ok: false, stdout: "", stderr: "not loaded", status: 3 };
    };
    const options: SplitBridgeLaunchAgentOptions = {
      bunPath: "/tmp/bun",
      cliPath: "/tmp/cli.ts",
      nativeBaseUrl: "https://chatgpt.com/backend-api/codex",
      gatewayBaseUrl: "http://127.0.0.1:10100/v1",
      admissionTokenFile: join(root, "split-token"),
      standardOutPath: join(root, "bridge.log"),
      standardErrorPath: join(root, "bridge.log"),
    };
    writeFileSync(options.admissionTokenFile, "bridge-secret\n", { mode: 0o600 });
    const deps = { home: root, configDir: join(root, "config"), launchctl, launchAgentOptions: options };
    expectedPlistPath = join(root, "Library", "LaunchAgents", "com.opencodex.split-bridge.plist");

    expect(installSplitBridgeService(deps)).toMatchObject({ installed: true, loaded: true, matchesPlist: true, pid: 4242 });
    const installedPath = splitBridgeServiceStatus(deps).plistPath;
    expect(readFileSync(installedPath, "utf8")).toContain("com.opencodex.split-bridge");
    expect(readFileSync(installedPath, "utf8")).toContain(options.admissionTokenFile);
    const installedPlist = readFileSync(installedPath, "utf8");
    expect(splitBridgeAdmissionTokenPathFromPlist(installedPlist)).toBe(options.admissionTokenFile);
    expect(splitBridgeLaunchAgentOptionsFromPlist(installedPlist)).toEqual(options);

    expect(stopSplitBridgeService(deps)).toMatchObject({ installed: true, loaded: false });
    expect(loadSplitBridgeService(deps)).toMatchObject({ installed: true, loaded: true });
    expect(repairSplitBridgeService(deps)).toMatchObject({ installed: true, loaded: true });
    expect(uninstallSplitBridgeService(deps)).toMatchObject({ installed: false, loaded: false });
    expect(existsSync(installedPath)).toBe(false);
    expect(calls.some(args => args[0] === "bootstrap")).toBe(true);
    expect(calls.some(args => args[0] === "bootout")).toBe(true);
  });

  test("status rejects stale plist contents and load repairs the loaded job", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-split-service-stale-"));
    let active = false;
    let expectedPlistPath = "";
    const launchctl = (args: string[]) => {
      if (args[0] === "bootstrap") {
        active = true;
        return { ok: true, stdout: "", stderr: "", status: 0 };
      }
      if (args[0] === "bootout") {
        const wasActive = active;
        active = false;
        return { ok: wasActive, stdout: "", stderr: wasActive ? "" : "not loaded", status: wasActive ? 0 : 3 };
      }
      return active
        ? { ok: true, stdout: `path = ${expectedPlistPath}\npid = 5252\n--split-plist-digest=${splitBridgeLaunchAgentDigest(options)}`, stderr: "", status: 0 }
        : { ok: false, stdout: "", stderr: "not loaded", status: 3 };
    };
    const options: SplitBridgeLaunchAgentOptions = {
      bunPath: "/tmp/bun",
      cliPath: "/tmp/cli.ts",
      nativeBaseUrl: "https://chatgpt.com/backend-api/codex",
      gatewayBaseUrl: "http://127.0.0.1:10100/v1",
      admissionTokenFile: join(root, "split-token"),
      standardOutPath: join(root, "bridge.log"),
      standardErrorPath: join(root, "bridge.log"),
    };
    writeFileSync(options.admissionTokenFile, "bridge-secret\n", { mode: 0o600 });
    const deps = { home: root, configDir: join(root, "config"), launchctl, launchAgentOptions: options };
    expectedPlistPath = join(root, "Library", "LaunchAgents", "com.opencodex.split-bridge.plist");

    expect(installSplitBridgeService(deps)).toMatchObject({ loaded: true, matchesPlist: true });
    writeFileSync(expectedPlistPath, "<stale-plist />", "utf8");
    expect(splitBridgeServiceStatus(deps)).toMatchObject({ loaded: true, matchesPlist: false });
    expect(loadSplitBridgeService(deps)).toMatchObject({ loaded: true, matchesPlist: false });
    expect(repairSplitBridgeService(deps)).toMatchObject({ loaded: true, matchesPlist: true });
  });

  test("install restores the previous plist and loaded job when replacement bootstrap fails", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-split-service-rollback-"));
    let active = false;
    let failNextBootstrap = false;
    let expectedPlistPath = "";
    const launchctl = (args: string[]) => {
      if (args[0] === "bootstrap") {
        if (failNextBootstrap) {
          failNextBootstrap = false;
          return { ok: false, stdout: "", stderr: "bootstrap failed", status: 5 };
        }
        active = true;
        return { ok: true, stdout: "", stderr: "", status: 0 };
      }
      if (args[0] === "bootout") {
        const wasActive = active;
        active = false;
        return { ok: wasActive, stdout: "", stderr: wasActive ? "" : "not loaded", status: wasActive ? 0 : 3 };
      }
      return active
        ? { ok: true, stdout: `path = ${expectedPlistPath}\npid = 6262\n--split-plist-digest=${splitBridgeLaunchAgentDigest(oldOptions)}`, stderr: "", status: 0 }
        : { ok: false, stdout: "", stderr: "not loaded", status: 3 };
    };
    const tokenFile = join(root, "split-token");
    writeFileSync(tokenFile, "bridge-secret\n", { mode: 0o600 });
    const oldOptions: SplitBridgeLaunchAgentOptions = {
      bunPath: "/tmp/bun",
      cliPath: "/tmp/cli.ts",
      nativeBaseUrl: "https://chatgpt.com/backend-api/codex",
      gatewayBaseUrl: "http://127.0.0.1:10100/v1",
      admissionTokenFile: tokenFile,
      standardOutPath: join(root, "bridge.log"),
      standardErrorPath: join(root, "bridge.log"),
    };
    expectedPlistPath = join(root, "Library", "LaunchAgents", "com.opencodex.split-bridge.plist");
    const deps = { home: root, configDir: join(root, "config"), launchctl, launchAgentOptions: oldOptions };
    installSplitBridgeService(deps);
    const previous = readFileSync(expectedPlistPath, "utf8");
    const nextOptions = { ...oldOptions, nativeBaseUrl: "https://native-new.example/codex" };
    failNextBootstrap = true;

    expect(() => installSplitBridgeService({ ...deps, launchAgentOptions: nextOptions })).toThrow("bootstrap failed");
    expect(readFileSync(expectedPlistPath, "utf8")).toBe(previous);
    expect(splitBridgeServiceStatus(deps)).toMatchObject({ loaded: true, matchesPlist: true, pid: 6262 });
  });

  test("status rejects a plist whose values changed while retaining its old digest", () => {
    root = mkdtempSync(join(tmpdir(), "ocx-split-service-digest-"));
    let active = false;
    let expectedPlistPath = "";
    const options: SplitBridgeLaunchAgentOptions = {
      bunPath: "/tmp/bun",
      cliPath: "/tmp/cli.ts",
      nativeBaseUrl: "https://chatgpt.com/backend-api/codex",
      gatewayBaseUrl: "http://127.0.0.1:10100/v1",
      admissionTokenFile: join(root, "split-token"),
      standardOutPath: join(root, "bridge.log"),
      standardErrorPath: join(root, "bridge.log"),
    };
    writeFileSync(options.admissionTokenFile, "bridge-secret\n", { mode: 0o600 });
    const launchctl = (args: string[]) => {
      if (args[0] === "bootstrap") {
        active = true;
        return { ok: true, stdout: "", stderr: "", status: 0 };
      }
      if (args[0] === "bootout") {
        const wasActive = active;
        active = false;
        return { ok: wasActive, stdout: "", stderr: wasActive ? "" : "not loaded", status: wasActive ? 0 : 3 };
      }
      return active
        ? { ok: true, stdout: `path = ${expectedPlistPath}\npid = 7272\n--split-plist-digest=${splitBridgeLaunchAgentDigest(options)}`, stderr: "", status: 0 }
        : { ok: false, stdout: "", stderr: "not loaded", status: 3 };
    };
    const deps = { home: root, configDir: join(root, "config"), launchctl, launchAgentOptions: options };
    expectedPlistPath = join(root, "Library", "LaunchAgents", "com.opencodex.split-bridge.plist");

    installSplitBridgeService(deps);
    const installed = readFileSync(expectedPlistPath, "utf8");
    writeFileSync(expectedPlistPath, installed.replace(options.nativeBaseUrl, "https://native-changed.example/codex"), "utf8");

    expect(splitBridgeServiceStatus({ home: root, configDir: join(root, "config"), launchctl }))
      .toMatchObject({ loaded: true, matchesPlist: false, pid: 7272 });
  });
});
