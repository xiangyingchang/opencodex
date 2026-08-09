import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  hasSplitBridgeAdmission,
  readSplitBridgeAdmissionToken,
  SPLIT_BRIDGE_ADMISSION_HEADER,
} from "../src/server/bridge-admission";

describe("split bridge gateway admission", () => {
  test("accepts only the exact bridge header token", () => {
    const expected = "bridge-secret-for-test";
    const request = (value?: string) => new Request("http://127.0.0.1:10100/v1/responses", {
      headers: value === undefined ? undefined : { [SPLIT_BRIDGE_ADMISSION_HEADER]: value },
    });

    expect(hasSplitBridgeAdmission(request(expected), expected)).toBe(true);
    expect(hasSplitBridgeAdmission(request("wrong"), expected)).toBe(false);
    expect(hasSplitBridgeAdmission(request(), expected)).toBe(false);
    expect(hasSplitBridgeAdmission(request(expected), undefined)).toBe(false);
  });

  test("requires a regular owner-only token file", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-bridge-admission-"));
    const path = join(root, "token");
    try {
      writeFileSync(path, "bridge-secret\n", { mode: 0o600 });
      expect(readSplitBridgeAdmissionToken(path)).toBe("bridge-secret");
      chmodSync(path, 0o640);
      expect(() => readSplitBridgeAdmissionToken(path)).toThrow(/group\/world accessible/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the gateway rejects direct Responses traffic when split admission is configured", async () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedCodexHome: IsolatedCodexHome = installIsolatedCodexHome("ocx-bridge-admission-codex-");
    const home = mkdtempSync(join(tmpdir(), "ocx-bridge-admission-home-"));
    process.env.OPENCODEX_HOME = home;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      codexRoutingMode: "split",
      defaultProvider: "ollama-test",
      providers: {
        "ollama-test": {
          adapter: "openai-chat",
          baseUrl: "http://127.0.0.1:9/v1",
          authMode: "local",
          allowPrivateNetwork: true,
          models: ["known-model"],
          defaultModel: "known-model",
        },
      },
    } as OcxConfig);
    const server = startServer(0, { splitBridgeAdmissionToken: "bridge-secret" });
    try {
      const request = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "unknown-model", input: "hello", stream: false }),
      };
      const rejected = await fetch(new URL("/v1/responses", server.url), request);
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toMatchObject({
        error: { code: "split_bridge_admission_required" },
      });

      const accepted = await fetch(new URL("/v1/responses", server.url), {
        ...request,
        headers: {
          ...request.headers,
          [SPLIT_BRIDGE_ADMISSION_HEADER]: "bridge-secret",
        },
      });
      expect(accepted.status).not.toBe(401);
      expect((await accepted.json()) as { error?: { code?: string } }).not.toMatchObject({
        error: { code: "split_bridge_admission_required" },
      });

      const chat = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "known-model", messages: [] }),
      });
      expect(chat.status).toBe(401);
      expect(await chat.json()).toMatchObject({
        error: { code: "split_bridge_admission_required" },
      });
    } finally {
      await server.stop(true);
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      isolatedCodexHome.restore();
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("split mode refuses to start without a configured admission token", () => {
    const previousHome = process.env.OPENCODEX_HOME;
    const isolatedCodexHome: IsolatedCodexHome = installIsolatedCodexHome("ocx-bridge-admission-missing-");
    const home = mkdtempSync(join(tmpdir(), "ocx-bridge-admission-missing-home-"));
    process.env.OPENCODEX_HOME = home;
    try {
      saveConfig({
        port: 0,
        hostname: "127.0.0.1",
        codexRoutingMode: "split",
        defaultProvider: "openai",
        providers: {},
      } as OcxConfig);
      expect(() => startServer(0, { splitBridgeAdmissionToken: null })).toThrow(/split routing requires a valid split bridge admission token file/);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      isolatedCodexHome.restore();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
