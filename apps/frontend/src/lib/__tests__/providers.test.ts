import { beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDERS,
  getProvider,
  loadProviders,
  makeProviderId,
  parseModelList,
  removeProvider,
  saveProviders,
  upsertProvider,
  type ProviderConfig,
} from "../providers";

describe("providers catalogue", () => {
  beforeEach(() => {
    // Reset both the in-module cache and (when available) storage by saving
    // the built-ins back. The test localStorage shim is minimal, so we avoid
    // calling removeItem/clear directly.
    saveProviders(BUILTIN_PROVIDERS.map((p) => ({ ...p, models: [...p.models] })));
  });

  it("ships the expected built-in cloud providers", () => {
    const ids = loadProviders().map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining(["openai", "google-ai-studio", "groq", "xai", "anthropic"]),
    );
  });

  it("every built-in is OpenAI-compatible (has a base URL and at least one model)", () => {
    for (const p of BUILTIN_PROVIDERS) {
      expect(p.baseUrl).toMatch(/^https?:\/\//);
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it("adds, looks up, and removes a custom provider", () => {
    const id = makeProviderId("My Local Gateway");
    expect(id).toMatch(/^custom-my-local-gateway-/);
    const custom: ProviderConfig = {
      id,
      name: "My Local Gateway",
      baseUrl: "https://gw.example.com/v1",
      requiresKey: true,
      builtin: false,
      models: parseModelList("model-a, model-b"),
    };
    upsertProvider(custom);
    expect(getProvider(id)?.models.map((m) => m.id)).toEqual(["model-a", "model-b"]);

    removeProvider(id);
    expect(getProvider(id)).toBeUndefined();
  });

  it("does not delete built-in providers", () => {
    removeProvider("openai");
    expect(getProvider("openai")).toBeDefined();
  });

  it("parses comma and newline separated model lists", () => {
    expect(parseModelList("a, b\n c ,,").map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(parseModelList("")).toEqual([]);
  });

  it("persists edits to a built-in provider's models and base URL", () => {
    const openai = getProvider("openai")!;
    upsertProvider({ ...openai, baseUrl: "https://proxy.local/v1", models: parseModelList("gpt-x") });
    const reloaded = getProvider("openai")!;
    expect(reloaded.baseUrl).toBe("https://proxy.local/v1");
    expect(reloaded.models.map((m) => m.id)).toEqual(["gpt-x"]);
  });
});
