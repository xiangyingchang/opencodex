import { describe, expect, test } from "bun:test";
import {
  UpstreamRetryEvidenceError,
  fetchWithTransientRetry,
  isTransientUpstreamStatus,
} from "../src/lib/upstream-retry";

function bodyResponse(status: number, headers?: Record<string, string>): Response {
  // ReadableStream body so cancel() is observable.
  let cancelled = false;
  const stream = new ReadableStream({
    cancel() { cancelled = true; },
  });
  const res = new Response(status === 204 ? null : stream, { status, headers });
  return Object.assign(res, { __wasCancelled: () => cancelled });
}

describe("isTransientUpstreamStatus", () => {
  test("classifies gateway/Cloudflare transients, excludes 4xx and 507", () => {
    for (const s of [500, 502, 503, 504, 520, 521, 522]) expect(isTransientUpstreamStatus(s)).toBe(true);
    for (const s of [200, 400, 401, 429, 499, 507, 529]) expect(isTransientUpstreamStatus(s)).toBe(false);
  });
});

describe("fetchWithTransientRetry", () => {
  test("retries a 502 then returns the 200; failed body is cancelled", async () => {
    const first = bodyResponse(502) as Response & { __wasCancelled: () => boolean };
    const responses = [first, bodyResponse(200)];
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => responses[calls++]!, { slowAttemptMs: 60_000 });
    expect(calls).toBe(2);
    expect(res.status).toBe(200);
    expect(first.__wasCancelled()).toBe(true);
  });

  test("exhausts attempts on persistent 502 and returns the final 502 with body intact", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return bodyResponse(502); }, { slowAttemptMs: 60_000 });
    expect(calls).toBe(3);
    expect(res.status).toBe(502);
    expect(res.body).not.toBeNull();
  });

  test("shares attempts across connection resets and transient responses", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      const positionInRound = calls++ % 3;
      if (positionInRound < 2) {
        throw Object.assign(
          new Error("The socket connection was closed unexpectedly."),
          { code: "ECONNRESET" },
        );
      }
      return bodyResponse(502);
    }, { attempts: 3, slowAttemptMs: 60_000 });
    expect(calls).toBe(3);
    expect(res.status).toBe(502);
  });

  test("does not re-arm the budget after a transient response before resets", async () => {
    let calls = 0;
    await expect(fetchWithTransientRetry(async () => {
      calls++;
      if (calls === 1) return bodyResponse(502);
      throw Object.assign(
        new Error("The socket connection was closed unexpectedly."),
        { code: "ECONNRESET" },
      );
    }, { attempts: 3, slowAttemptMs: 60_000 })).rejects.toMatchObject({
      name: "UpstreamRetryEvidenceError",
      transientStatuses: [502],
    });
    expect(calls).toBe(3);
  });

  test("flattens nested evidence after 5xx then reset then refusal", async () => {
    let calls = 0;
    const failure = await fetchWithTransientRetry(async () => {
      calls++;
      if (calls === 1) return bodyResponse(502);
      if (calls === 2) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    }, { attempts: 3, slowAttemptMs: 60_000 }).catch(error => error);
    expect(calls).toBe(3);
    expect(failure).toBeInstanceOf(UpstreamRetryEvidenceError);
    const evidence = failure as UpstreamRetryEvidenceError;
    expect(evidence.transientStatuses).toEqual([502]);
    expect(evidence.resetSeen).toBe(true);
    expect(evidence.cause).not.toBeInstanceOf(UpstreamRetryEvidenceError);
    expect((evidence.cause as Error & { code?: string }).code).toBe("ECONNREFUSED");
  });

  test("preserves reset evidence across a successful reset retry before a later refusal", async () => {
    let calls = 0;
    const failure = await fetchWithTransientRetry(async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      if (calls === 2) return bodyResponse(502);
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    }, { attempts: 3, slowAttemptMs: 60_000 }).catch(error => error);
    expect(calls).toBe(3);
    expect(failure).toBeInstanceOf(UpstreamRetryEvidenceError);
    const evidence = failure as UpstreamRetryEvidenceError;
    expect(evidence.transientStatuses).toEqual([502]);
    expect(evidence.resetSeen).toBe(true);
    expect((evidence.cause as Error & { code?: string }).code).toBe("ECONNREFUSED");
  });

  test("wraps the terminal connection reset with accumulated evidence", async () => {
    let calls = 0;
    const failure = await fetchWithTransientRetry(async () => {
      calls++;
      throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
    }, { attempts: 2, slowAttemptMs: 60_000 }).catch(error => error);
    expect(calls).toBe(2);
    expect(failure).toBeInstanceOf(UpstreamRetryEvidenceError);
    const evidence = failure as UpstreamRetryEvidenceError;
    expect(evidence.transientStatuses).toEqual([]);
    expect(evidence.resetSeen).toBe(true);
    expect((evidence.cause as Error & { code?: string }).code).toBe("ECONNRESET");
  });

  test("does not retry non-transient statuses", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => { calls++; return bodyResponse(400); }, { slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(400);
  });

  test("honors Retry-After header for the backoff delay", async () => {
    let calls = 0;
    const started = Date.now();
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      return calls === 1 ? bodyResponse(503, { "retry-after": "1" }) : bodyResponse(200);
    }, { slowAttemptMs: 60_000 });
    expect(res.status).toBe(200);
    // Retry-After: 1s should dominate the 400ms base backoff.
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  }, 10_000);

  test("returns the 5xx as-is when the caller aborted", async () => {
    const ac = new AbortController();
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      ac.abort();
      return bodyResponse(502);
    }, { abortSignal: ac.signal, slowAttemptMs: 60_000 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
  });

  test("waits for bounded response-body cancellation before the next retry", async () => {
    let cancelSettled = false;
    const first = new Response(new ReadableStream({
      cancel() {
        return new Promise<void>(resolve => {
          setTimeout(() => {
            cancelSettled = true;
            resolve();
          }, 20);
        });
      },
    }), { status: 503, headers: { "retry-after": "0" } });
    let calls = 0;

    const result = await fetchWithTransientRetry(async () => {
      calls += 1;
      if (calls === 1) return first;
      expect(cancelSettled).toBe(true);
      return bodyResponse(200);
    }, { attempts: 2, slowAttemptMs: 60_000 });

    expect(result.status).toBe(200);
    expect(calls).toBe(2);
  });

  test("does not retry a slow failed attempt (slow-502 incident shape)", async () => {
    let calls = 0;
    const res = await fetchWithTransientRetry(async () => {
      calls++;
      await new Promise(r => setTimeout(r, 30));
      return bodyResponse(502);
    }, { slowAttemptMs: 10 });
    expect(calls).toBe(1);
    expect(res.status).toBe(502);
  });
});
