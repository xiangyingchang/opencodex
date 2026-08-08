import { describe, expect, test } from "bun:test";
import {
  classifyCodexSplitState,
  restoreBridgeOwnedRouting,
} from "../src/codex/inject";

const splitUrl = 'http://127.0.0.1:10101/v1';
const legacyUrl = 'http://127.0.0.1:10100/v1';

const native = [
  'model = "gpt-5.5"',
  'openai_base_url = "https://api.openai.com/v1"',
  '',
  '[features]',
  'fast_mode = true',
  '',
].join("\n");

describe("Codex split routing state", () => {
  test("absent or native upstream routing is native and not bridge-owned", () => {
    expect(classifyCodexSplitState('model = "gpt-5.5"\n')).toMatchObject({
      state: "native",
      owned: false,
    });
    expect(classifyCodexSplitState(native)).toMatchObject({
      state: "native",
      owned: false,
      reason: "user-owned-openai-base-url",
    });
  });

  test("marker-owned 10101 root routing is split", () => {
    const content = `# Auto-injected by opencodex\nopenai_base_url = "${splitUrl}"\n`;
    expect(classifyCodexSplitState(content)).toMatchObject({
      state: "split",
      owned: true,
      baseUrl: splitUrl,
    });
  });

  test("marker-owned 10100 root or legacy provider routing is legacy-local", () => {
    const root = `# Auto-injected by opencodex\nopenai_base_url = "${legacyUrl}"\n`;
    expect(classifyCodexSplitState(root)).toMatchObject({ state: "legacy-local", owned: true });

    const table = [
      'model_provider = "opencodex"',
      '',
      '# Auto-injected by opencodex',
      '[model_providers.opencodex]',
      `base_url = "${legacyUrl}"`,
      'wire_api = "responses"',
      '',
    ].join("\n");
    expect(classifyCodexSplitState(table)).toMatchObject({ state: "legacy-local", owned: true });
  });

  test("same URL without the ownership marker is user-owned and cannot be restored", () => {
    const content = `openai_base_url = "${splitUrl}"\nmodel = "gpt-5.5"\n`;
    const observed = classifyCodexSplitState(content);
    expect(observed).toMatchObject({ state: "native", owned: false, reason: "user-owned-openai-base-url" });
    expect(restoreBridgeOwnedRouting(content)).toMatchObject({
      content,
      changed: false,
      refused: false,
    });
  });

  test("legacy routing without a marker is detected but refuses blind overwrite", () => {
    const content = [
      'model_provider = "opencodex"',
      '',
      '[model_providers.opencodex]',
      `base_url = "${legacyUrl}"`,
      '',
    ].join("\n");
    expect(classifyCodexSplitState(content)).toMatchObject({
      state: "legacy-local",
      owned: false,
      reason: "legacy-route-without-marker",
    });
    expect(restoreBridgeOwnedRouting(content)).toMatchObject({
      content,
      changed: false,
      refused: true,
    });
  });

  test("restore removes only the exact bridge-owned root keys and preserves user settings", () => {
    const content = [
      'model = "deepseek/deepseek-v4-flash"',
      '# user comment',
      '# Auto-injected by opencodex',
      `openai_base_url = "${splitUrl}"`,
      '',
      '[features]',
      'fast_mode = true',
      '',
    ].join("\n");
    const restored = restoreBridgeOwnedRouting(content);
    expect(restored.changed).toBe(true);
    expect(restored.refused).toBe(false);
    expect(restored.content).toContain('model = "deepseek/deepseek-v4-flash"');
    expect(restored.content).toContain("# user comment");
    expect(restored.content).toContain("[features]");
    expect(restored.content).not.toContain("openai_base_url");
    expect(restored.content).not.toContain("Auto-injected by opencodex");
    expect(restoreBridgeOwnedRouting(restored.content).content).toBe(restored.content);
  });

  test("restore removes the owned legacy provider block but leaves model and unrelated tables", () => {
    const content = [
      'model_provider = "opencodex"',
      'model = "deepseek/deepseek-v4-flash"',
      '',
      '[features]',
      'fast_mode = true',
      '',
      '# Auto-injected by opencodex',
      '[model_providers.opencodex]',
      `base_url = "${legacyUrl}"`,
      'wire_api = "responses"',
      '',
      '[profiles.work]',
      'model = "gpt-5.5"',
      '',
    ].join("\n");
    const restored = restoreBridgeOwnedRouting(content);
    expect(restored.changed).toBe(true);
    expect(restored.content).not.toContain('model_provider = "opencodex"');
    expect(restored.content).not.toContain("[model_providers.opencodex]");
    expect(restored.content).toContain('model = "deepseek/deepseek-v4-flash"');
    expect(restored.content).toContain("[profiles.work]");
  });
});
