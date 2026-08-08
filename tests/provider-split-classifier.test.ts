import { describe, expect, test } from "bun:test";
import { classifyProviderSplitModel } from "../src/providers/split-map";
import type { ProviderSplitCatalog } from "../src/providers/split-map";

const catalog: ProviderSplitCatalog = {
  generation: "catalog-test-1",
  officialModels: new Set(["gpt-5.6-luna", "gpt-5.5"]),
  officialAccountNamespaces: new Set(["side"]),
  officialApiKeyModels: new Set(["openai-apikey/gpt-5.6-luna"]),
  thirdPartyModels: new Set([
    "ark-coding/deepseek-v4-flash",
    "deepseek/deepseek-v4-flash",
  ]),
};

describe("Provider Split Map", () => {
  test("routes bare native GPT models to the official channel", () => {
    expect(classifyProviderSplitModel("gpt-5.6-luna", catalog)).toEqual({
      channel: "official-native",
      canonicalModel: "gpt-5.6-luna",
      provider: "openai",
      reason: "official-model-allowlist",
    });
  });

  test("routes account-qualified native GPT models to the official account channel", () => {
    expect(classifyProviderSplitModel("side/gpt-5.5", catalog)).toEqual({
      channel: "official-native-account",
      canonicalModel: "gpt-5.5",
      provider: "openai",
      reason: "official-account-namespace",
    });
  });

  test("keeps OpenAI API-key entries distinct from native Codex login", () => {
    expect(classifyProviderSplitModel("openai-apikey/gpt-5.6-luna", catalog)).toEqual({
      channel: "official-api-key",
      canonicalModel: "openai-apikey/gpt-5.6-luna",
      provider: "openai-apikey",
      reason: "official-api-key-allowlist",
    });
  });

  test("routes only cataloged provider/model entries to the third-party gateway", () => {
    expect(classifyProviderSplitModel("deepseek/deepseek-v4-flash", catalog)).toEqual({
      channel: "third-party-gateway",
      canonicalModel: "deepseek/deepseek-v4-flash",
      provider: "deepseek",
      reason: "third-party-model-allowlist",
    });
  });

  test("fails closed for unknown, empty, and malformed model ids", () => {
    for (const model of ["", "   ", "unknown/model", "gpt-unknown", "side/claude-opus"]) {
      expect(classifyProviderSplitModel(model, catalog)).toEqual({
        channel: "invalid",
        canonicalModel: null,
        provider: null,
        reason: "unknown-model",
      });
    }
  });

  test("gives the official allowlist precedence over a colliding third-party slug", () => {
    const collisionCatalog: ProviderSplitCatalog = {
      ...catalog,
      thirdPartyModels: new Set([...catalog.thirdPartyModels, "gpt-5.6-luna"]),
    };
    expect(classifyProviderSplitModel("gpt-5.6-luna", collisionCatalog).channel).toBe("official-native");
  });
});
