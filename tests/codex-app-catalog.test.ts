import { describe, expect, test } from "bun:test";
import { buildProviderSplitCatalog } from "../src/codex/catalog";

const entries = [
  { slug: "gpt-5.5", visibility: "list" },
  { slug: "side/gpt-5.5", visibility: "list" },
  { slug: "openai-apikey/gpt-5.5", visibility: "list" },
  { slug: "deepseek/deepseek-v4-flash", visibility: "list" },
  { slug: "ark-coding/kimi-k2.7-code", visibility: "list" },
  { slug: "hidden/provider-model", visibility: "hide" },
  { slug: "unknown-bare-model", visibility: "list" },
];

describe("Codex App split catalog contract", () => {
  test("keeps official and third-party identities when the gateway is down", () => {
    const catalog = buildProviderSplitCatalog({
      entries,
      officialAccountNamespaces: ["side"],
      disabledModels: ["ark-coding/kimi-k2.7-code"],
      gatewayReachable: false,
    });

    expect([...catalog.officialModels]).toContain("gpt-5.5");
    expect([...catalog.officialAccountNamespaces]).toEqual(["side"]);
    expect([...catalog.officialAccountSlugs]).toEqual(["side/gpt-5.5"]);
    expect([...catalog.officialAccountModels]).toEqual(["gpt-5.5"]);
    expect([...catalog.officialApiKeyModels]).toContain("openai-apikey/gpt-5.5");
    expect([...catalog.thirdPartyModels]).toEqual(["deepseek/deepseek-v4-flash"]);
  });

  test("gateway health does not change catalog generation or visible identities", () => {
    const input = { entries, officialAccountNamespaces: ["side"] };
    const down = buildProviderSplitCatalog({ ...input, gatewayReachable: false });
    const up = buildProviderSplitCatalog({ ...input, gatewayReachable: true });

    expect(up.generation).toBe(down.generation);
    expect([...up.thirdPartyModels]).toEqual([...down.thirdPartyModels]);
  });

  test("excludes hidden, disabled, and unknown bare models without mutating source entries", () => {
    const snapshot = JSON.stringify(entries);
    const catalog = buildProviderSplitCatalog({
      entries,
      officialAccountNamespaces: ["side"],
      disabledModels: ["deepseek/deepseek-v4-flash"],
    });

    expect([...catalog.thirdPartyModels]).toEqual(["ark-coding/kimi-k2.7-code"]);
    expect([...catalog.officialModels]).not.toContain("unknown-bare-model");
    expect(JSON.stringify(entries)).toBe(snapshot);
  });

  test("produces deterministic generation independent of entry order", () => {
    const input = { officialAccountNamespaces: ["side"] };
    const first = buildProviderSplitCatalog({ ...input, entries });
    const second = buildProviderSplitCatalog({ ...input, entries: [...entries].reverse() });

    expect(second.generation).toBe(first.generation);
  });

  test("keeps account-only native rows separate from bare native rows", () => {
    const catalog = buildProviderSplitCatalog({
      entries: [{ slug: "side/gpt-5.5", visibility: "list" }],
      officialAccountNamespaces: ["side"],
    });
    expect([...catalog.officialModels]).toEqual([]);
    expect([...catalog.officialAccountModels]).toEqual(["gpt-5.5"]);
  });
});
