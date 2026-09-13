import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  drainAndShutdown,
  resetLifecycleDrainStateForTests,
  runListenerShutdown,
  runShutdownPhasesUntil,
  setServerStartupLifecycleReleaseForTests,
} from "../src/server/lifecycle";

describe("shutdown absolute deadline", () => {
  test("a hung phase cannot hold the deadline or block later best-effort phases", async () => {
    const events: string[] = [];
    const startedAt = performance.now();
    const result = await runShutdownPhasesUntil(
      [
        { name: "hung", run: () => new Promise<void>(() => {}) },
        { name: "listener-stop", run: () => { events.push("listener-stop"); } },
        { name: "lifecycle-release", run: () => { events.push("lifecycle-release"); } },
      ],
      Date.now() + 25,
    );

    expect(performance.now() - startedAt).toBeLessThan(200);
    expect(events).toEqual(["listener-stop", "lifecycle-release"]);
    expect(result.timedOut).toBe(true);
    expect(result.timedOutPhases).toEqual(["hung"]);
    expect(result.detachedPhases).toEqual(["listener-stop", "lifecycle-release"]);
  });

  test("an expired deadline still attempts every cleanup phase without waiting", async () => {
    const events: string[] = [];
    const result = await runShutdownPhasesUntil(
      [
        { name: "shell", run: () => { events.push("shell"); } },
        { name: "state", run: () => { events.push("state"); } },
        { name: "storage", run: () => { events.push("storage"); } },
      ],
      Date.now() - 1,
    );

    expect(events).toEqual(["shell", "state", "storage"]);
    expect(result.timedOut).toBe(true);
    expect(result.timedOutPhases).toEqual([]);
    expect(result.detachedPhases).toEqual(["shell", "state", "storage"]);
  });

  test("a rejected phase is recorded and does not skip later cleanup", async () => {
    const events: string[] = [];
    const result = await runShutdownPhasesUntil(
      [
        { name: "flush", run: async () => { throw new Error("flush failed"); } },
        { name: "worker-join", run: () => { events.push("worker-join"); } },
      ],
      Date.now() + 1_000,
    );

    expect(events).toEqual(["worker-join"]);
    expect(result.timedOut).toBe(false);
    expect(result.failedPhases).toEqual(["flush"]);
  });

  test("a rejected shutdown phase makes the completed shutdown fail closed", async () => {
    resetLifecycleDrainStateForTests();
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ok"),
    });
    setServerStartupLifecycleReleaseForTests(() => {
      throw new Error("fixture lifecycle release failure");
    });

    try {
      await expect(drainAndShutdown(server, 1_000)).rejects.toThrow(
        "shutdown cleanup phases failed: startup lifecycle release",
      );
    } finally {
      resetLifecycleDrainStateForTests();
    }
  });

  test("repeated shutdown calls share one process-lifetime flight", async () => {
    resetLifecycleDrainStateForTests();
    const first = drainAndShutdown(undefined, 0);
    const second = drainAndShutdown(undefined, 0);

    expect(second).toBe(first);
    await first;
    resetLifecycleDrainStateForTests();
  });

  test("a hung listener step does not prevent later listener cleanup from starting", async () => {
    const events: string[] = [];
    void runListenerShutdown(
      [
        () => new Promise<void>(() => {}),
        async () => { events.push("loopback-stop"); },
      ],
      async () => { events.push("lifecycle-release"); },
    );
    await Bun.sleep(20);
    expect(events).toEqual(["loopback-stop", "lifecycle-release"]);
  });
});

describe("drainAndShutdown deadline wiring", () => {
  const lifecycleSource = readFileSync(join(import.meta.dir, "../src/server/lifecycle.ts"), "utf8");
  const managementSource = readFileSync(join(import.meta.dir, "../src/server/management-api.ts"), "utf8");

  test("uses one captured absolute deadline and the shared phase runner", () => {
    expect(lifecycleSource).toContain("const deadline = Date.now()");
    expect(lifecycleSource).toContain("runShutdownPhasesUntil(");
    expect(lifecycleSource).toContain("deadline - Date.now()");
  });

  test("management stop handles fail-closed shutdown rejection", () => {
    const start = managementSource.indexOf("setTimeout(async () => {");
    const end = managementSource.indexOf("}, 200);", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const delayedShutdown = managementSource.slice(start, end);
    expect(delayedShutdown).toContain("let shutdownOk = true;");
    expect(delayedShutdown).toContain("process.exit(shutdownOk ? 0 : 1)");
  });

  test("uses phase boundaries that isolate storage cleanup failures", async () => {
    for (const phaseName of [
      "storage scheduler stop",
      "optional shutdown hooks",
      "state-store sweeper stop",
      "queued storage spawn cancellation",
      "storage job abort",
      "storage worker join",
      "storage sink detach",
    ]) {
      expect(lifecycleSource).toContain(`name: "${phaseName}"`);
    }
  });
});
