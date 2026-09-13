import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  availableAccountGatedNativeModels,
  cachedAvailableAccountGatedNativeModels,
  entitledCodexAccountIdsForModel,
  isDirectCallerEntitledToCodexModel,
  resetCodexModelEntitlementCacheForTests,
  resolveCodexModelEntitlements,
  cachedAvailableAccountGatedNativeModels,
  seedCodexModelEntitlementsForTests,
  seedCodexModelEntitlementsForTests,
  type CodexModelEntitlementCredentialSnapshot,
} from "../src/codex/model-entitlements";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/main-account";
import { fakeChatGptJwt } from "./helpers/fake-chatgpt-jwt";

const DAYBREAK = "gpt-daybreak-blue-latest";
const ASTRA = "gpt-6-astra";

function seededCurrentIdentity(accountId: string): string | undefined {
  return accountId === "main" ? "test:main" : undefined;
}

function mainCredentialIdentity(accessToken: string, accountId: string): string {
  return `main:${accountId}:${createHash("sha256").update(accessToken).digest("hex")}`;
}

function writeMainAuth(home: string, accessToken: string, accountId: string): void {
  writeFileSync(join(home, "auth.json"), JSON.stringify({
    tokens: { access_token: accessToken, account_id: accountId },
  }), "utf8");
}

function credential(accountId: string): CodexModelEntitlementCredentialSnapshot {
  return {
    accountId,
    accessToken: `token-${accountId}`,
    chatgptAccountId: `chatgpt-${accountId}`,
    credentialIdentity: `test:${accountId}`,
  };
}

function roster(...slugs: string[]): Response {
  return Response.json({
    models: slugs.map(slug => ({ slug, supported_in_api: true, visibility: "list" })),
  });
}

beforeEach(() => resetCodexModelEntitlementCacheForTests());

describe("Codex account model entitlements", () => {
  test("keeps account-gated models scoped to the authenticated account roster", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main"), credential("secondary")],
      fetcher: (async (_input, init) => {
        const accountId = new Headers(init?.headers).get("chatgpt-account-id");
        return accountId === "chatgpt-main"
          ? roster("gpt-5.6-sol", DAYBREAK)
          : roster("gpt-5.6-sol");
      }) as typeof fetch,
      now: 1_000,
    });

    expect([...entitledCodexAccountIdsForModel(snapshot, DAYBREAK)!]).toEqual(["main"]);
    expect([...availableAccountGatedNativeModels(snapshot)]).toEqual([DAYBREAK]);
    expect(entitledCodexAccountIdsForModel(snapshot, "gpt-5.6-sol")).toBeUndefined();
  });

  test("recognizes GPT-6-Astra only when the authenticated roster lists it", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main"), credential("secondary")],
      fetcher: (async (_input, init) => {
        const accountId = new Headers(init?.headers).get("chatgpt-account-id");
        return accountId === "chatgpt-main" ? roster(ASTRA) : roster();
      }) as typeof fetch,
      now: 1_000,
    });

    expect([...entitledCodexAccountIdsForModel(snapshot, ASTRA)!]).toEqual(["main"]);
    expect([...availableAccountGatedNativeModels(snapshot)]).toEqual([ASTRA]);
  });

  test("fails closed when an account roster cannot be confirmed", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("broken")],
      fetcher: (async () => new Response("not-json", { status: 502 })) as typeof fetch,
      now: 1_000,
    });

    expect(snapshot.confirmedAccountIds.size).toBe(0);
    expect(entitledCodexAccountIdsForModel(snapshot, DAYBREAK)?.size).toBe(0);
    expect(availableAccountGatedNativeModels(snapshot).size).toBe(0);
  });

  test("cached selector projection drops a roster after credential replacement", () => {
    const identities = new Map([["main", "test:main"]]);
    const currentIdentity = (accountId: string): string | undefined => identities.get(accountId);
    seedCodexModelEntitlementsForTests("main", [ASTRA], 1_000);

    expect([...cachedAvailableAccountGatedNativeModels(1_000, undefined, currentIdentity)])
      .toContain(ASTRA);

    identities.set("main", "test:replacement");
    expect([...cachedAvailableAccountGatedNativeModels(1_000, undefined, currentIdentity)])
      .not.toContain(ASTRA);
  });

  test("main selector cache rejects same-account token replacement and expired JWTs", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-entitlement-main-"));
    const accountId = "main-account";
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const firstToken = fakeChatGptJwt({ exp: future, nonce: 1 });
    const secondToken = fakeChatGptJwt({ exp: future, nonce: 2 });
    const expiredToken = fakeChatGptJwt({ exp: Math.floor(Date.now() / 1000) - 1, nonce: 3 });
    try {
      process.env.CODEX_HOME = home;
      writeMainAuth(home, firstToken, accountId);
      await resolveCodexModelEntitlements({ codexAccounts: [] }, {
        credentials: [{
          accountId: MAIN_CODEX_ACCOUNT_ID,
          accessToken: firstToken,
          chatgptAccountId: accountId,
          credentialIdentity: mainCredentialIdentity(firstToken, accountId),
        }],
        fetcher: (async () => roster(ASTRA)) as typeof fetch,
      });
      expect([...cachedAvailableAccountGatedNativeModels()]).toContain(ASTRA);

      writeMainAuth(home, secondToken, accountId);
      expect([...cachedAvailableAccountGatedNativeModels()]).not.toContain(ASTRA);

      writeMainAuth(home, expiredToken, accountId);
      expect([...cachedAvailableAccountGatedNativeModels()]).not.toContain(ASTRA);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("main selector cache fails closed for opaque and missing-exp access tokens", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-entitlement-main-"));
    const accountId = "main-account";
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const validToken = fakeChatGptJwt({ exp: future, nonce: 4 });
    const opaqueToken = "opaque-main-access-token";
    const missingExpToken = fakeChatGptJwt({ nonce: 5 });
    const populate = async (accessToken: string) => {
      writeMainAuth(home, accessToken, accountId);
      await resolveCodexModelEntitlements({ codexAccounts: [] }, {
        credentials: [{
          accountId: MAIN_CODEX_ACCOUNT_ID,
          accessToken,
          chatgptAccountId: accountId,
          credentialIdentity: mainCredentialIdentity(accessToken, accountId),
        }],
        fetcher: (async () => roster(ASTRA)) as typeof fetch,
      });
    };
    try {
      process.env.CODEX_HOME = home;
      await populate(validToken);
      expect([...cachedAvailableAccountGatedNativeModels()]).toContain(ASTRA);

      resetCodexModelEntitlementCacheForTests();
      await populate(opaqueToken);
      expect([...cachedAvailableAccountGatedNativeModels()]).not.toContain(ASTRA);

      resetCodexModelEntitlementCacheForTests();
      await populate(missingExpToken);
      expect([...cachedAvailableAccountGatedNativeModels()]).not.toContain(ASTRA);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("resolve snapshot omits non-live main credentials", async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const home = mkdtempSync(join(tmpdir(), "ocx-entitlement-main-"));
    const accountId = "main-account";
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const validToken = fakeChatGptJwt({ exp: future, nonce: 6 });
    const opaqueToken = "opaque-main-snapshot-token";
    const missingExpToken = fakeChatGptJwt({ nonce: 7 });
    const resolveFromLocalAuth = async () => resolveCodexModelEntitlements({ codexAccounts: [] }, {
      fetcher: (async () => roster(ASTRA)) as typeof fetch,
    });
    try {
      process.env.CODEX_HOME = home;

      writeMainAuth(home, validToken, accountId);
      const validSnapshot = await resolveFromLocalAuth();
      expect(validSnapshot.modelsByAccount.get(MAIN_CODEX_ACCOUNT_ID)?.has(ASTRA)).toBe(true);

      resetCodexModelEntitlementCacheForTests();
      writeMainAuth(home, opaqueToken, accountId);
      const opaqueSnapshot = await resolveFromLocalAuth();
      expect(opaqueSnapshot.modelsByAccount.has(MAIN_CODEX_ACCOUNT_ID)).toBe(false);

      resetCodexModelEntitlementCacheForTests();
      writeMainAuth(home, missingExpToken, accountId);
      const missingExpSnapshot = await resolveFromLocalAuth();
      expect(missingExpSnapshot.modelsByAccount.has(MAIN_CODEX_ACCOUNT_ID)).toBe(false);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("ignores hidden or API-disabled rows", async () => {
    const snapshot = await resolveCodexModelEntitlements({ codexAccounts: [] }, {
      credentials: [credential("main")],
      fetcher: (async () => Response.json({ models: [
        { slug: DAYBREAK, supported_in_api: true, visibility: "hide" },
        { slug: "gpt-disabled", supported_in_api: false, visibility: "list" },
      ] })) as typeof fetch,
      now: 1_000,
    });

    expect(snapshot.confirmedAccountIds.has("main")).toBe(true);
    expect(entitledCodexAccountIdsForModel(snapshot, DAYBREAK)?.size).toBe(0);
  });

  test("checks a Direct caller's own bearer instead of a local Pool account", async () => {
    let seenAuthorization = "";
    let seenAccount = "";
    const entitled = await isDirectCallerEntitledToCodexModel(
      new Headers({
        authorization: "Bearer caller-token",
        "chatgpt-account-id": "caller-account",
      }),
      DAYBREAK,
      {
        fetcher: (async (_input, init) => {
          const headers = new Headers(init?.headers);
          seenAuthorization = headers.get("authorization") ?? "";
          seenAccount = headers.get("chatgpt-account-id") ?? "";
          return roster("gpt-5.6-sol", DAYBREAK);
        }) as typeof fetch,
        now: 1_000,
      },
    );

    expect(entitled).toBe(true);
    expect(seenAuthorization).toBe("Bearer caller-token");
    expect(seenAccount).toBe("caller-account");
  });

  test("Direct entitlement fails closed on an unconfirmed roster", async () => {
    await expect(isDirectCallerEntitledToCodexModel(
      new Headers({ authorization: "Bearer caller-token" }),
      DAYBREAK,
      {
        fetcher: (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
        now: 1_000,
      },
    )).resolves.toBe(false);
  });

  test("Direct-caller rosters do not evict main/Pool entitlement evidence", async () => {
    // The catalog projects ONLY from main/Pool keys. Under a single shared LRU, a burst of
    // distinct Direct callers pushed those out and the gated row vanished from the catalog until
    // rediscovery — fail-closed flapping whose cause an operator cannot see.
    seedCodexModelEntitlementsForTests("main", [DAYBREAK], 1_000);
    expect([...cachedAvailableAccountGatedNativeModels(1_000, undefined, seededCurrentIdentity)])
      .toContain(DAYBREAK);

    // Far more distinct Direct callers than the per-class cache bound of 64.
    for (let i = 0; i < 80; i += 1) {
      await isDirectCallerEntitledToCodexModel(
        new Headers({ authorization: `Bearer caller-${i}` }),
        DAYBREAK,
        { fetcher: (async () => roster(DAYBREAK)) as typeof fetch, now: 1_000 },
      );
    }

    // With one shared 64-entry LRU this read came back empty. The main grant is a different
    // eviction class and is still inside its TTL, so it must survive.
    expect([...cachedAvailableAccountGatedNativeModels(1_000, undefined, seededCurrentIdentity)])
      .toContain(DAYBREAK);
  });

  test("Direct-caller rosters do not evict main/Pool entitlement evidence", async () => {
    // The catalog projects ONLY from main/Pool keys. Under a single shared LRU, a burst of
    // distinct Direct callers pushed those out and the gated row vanished from the catalog
    // until rediscovery — fail-closed flapping whose cause an operator cannot see.
    seedCodexModelEntitlementsForTests("main", [DAYBREAK], 1_000);
    expect([...cachedAvailableAccountGatedNativeModels(1_000, undefined, seededCurrentIdentity)])
      .toContain(DAYBREAK);

    // Far more distinct Direct callers than the per-class cache bound of 64.
    for (let i = 0; i < 80; i += 1) {
      await isDirectCallerEntitledToCodexModel(
        new Headers({ authorization: `Bearer caller-${i}` }),
        DAYBREAK,
        { fetcher: (async () => roster(DAYBREAK)) as typeof fetch, now: 1_000 },
      );
    }

    // With one shared 64-entry LRU this read came back empty. The main grant is a different
    // eviction class and is still inside its TTL, so it must survive.
    expect([...cachedAvailableAccountGatedNativeModels(1_000, undefined, seededCurrentIdentity)])
      .toContain(DAYBREAK);
  });
});
