import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const restoreChild = join(repoRoot, "tests", "helpers", "codex-restore-race-child.ts");
const injectChild = join(repoRoot, "tests", "helpers", "codex-inject-race-child.ts");

let root = "";
let codexHome = "";
let opencodexHome = "";

function runInject(port: number): { success: boolean; message: string } {
  const result = spawnSync(process.execPath, [injectChild], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: codexHome,
      OPENCODEX_HOME: opencodexHome,
      OCX_INJECT_RACE_PAYLOAD: JSON.stringify({ port, lockTimeoutMs: 0 }),
    },
  });
  return JSON.parse((result.stdout ?? "{}").trim().split("\n").filter(Boolean).pop() ?? "{}");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-restore-race-"));
  codexHome = join(root, ".codex");
  opencodexHome = join(root, ".opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(opencodexHome, { recursive: true });
  writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("Codex restore/injection write-lock race", () => {
  test("restore cannot overwrite an injection that starts while restore is paused", async () => {
    expect(runInject(10100).success).toBe(true);
    const hold = join(root, "restore-held");
    const release = join(root, "restore-release");
    const restore = Bun.spawn([process.execPath, restoreChild], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        OPENCODEX_HOME: opencodexHome,
        OCX_RESTORE_RACE_HOLD: hold,
        OCX_RESTORE_RACE_RELEASE: release,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const deadline = Date.now() + 10_000;
    while (!existsSync(hold) && Date.now() < deadline) {
      Bun.sleepSync(10);
    }
    expect(existsSync(hold)).toBe(true);

    const contender = runInject(20200);
    writeFileSync(release, "release\n", { mode: 0o600 });
    const [restoreOutput] = await Promise.all([
      new Response(restore.stdout).text(),
      restore.exited,
    ]);
    const restoreResult = JSON.parse(restoreOutput.trim().split("\n").filter(Boolean).pop() ?? "{}");

    expect(contender.success).toBe(false);
    expect(contender.message).toContain("Another process is writing Codex configuration");
    expect(restoreResult.success).toBe(true);
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).not.toContain("20200");
  }, 30_000);
});
