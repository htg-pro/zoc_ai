/**
 * The model catalogue and the context-window chain — zoc-agent-chat-rebuild R12.10,
 * R13.12, 9.7.
 *
 * The chain is the part worth guarding. It is the one mechanism the design marks as
 * surviving `MemoryIndicator`'s deletion, and every step of it is a case where the
 * obvious implementation returns something unusable: a `0` for an unknown model, a
 * cloud window for a local file that happens to share its name, or a crash on a
 * model reference the user typed by hand.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_CONTEXT_WINDOW,
  MODELS,
  contextWindowFor,
  modelCatalogue,
  modelSpec,
} from "../models.ts";
import { PROVIDERS } from "../registry.ts";

describe("the catalogue", () => {
  it("names only providers the registry can actually reach", async () => {
    // A catalogue row for a provider `resolveModel` cannot resolve is a picker entry
    // that 404s when chosen, which is the one failure a static table can introduce.
    const known = new Set(PROVIDERS.map((spec) => spec.id));
    for (const model of MODELS) {
      expect(known.has(model.provider)).toBe(true);
    }
  });

  it("has no duplicate provider-and-model pair", () => {
    const keys = MODELS.map((model) => `${model.provider}/${model.modelId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("declares a positive window for every row", () => {
    for (const model of MODELS) {
      expect(model.contextWindow).toBeGreaterThan(0);
    }
  });

  it("carries no local rows, because their windows are Desktop_Core's to know", () => {
    expect(MODELS.filter((model) => model.provider === "local-llamacpp")).toEqual([]);
  });

  it("filters by provider, and answers everything without one", () => {
    expect(modelCatalogue()).toEqual(MODELS);
    const groq = modelCatalogue("groq");
    expect(groq.length).toBeGreaterThan(0);
    expect(groq.every((model) => model.provider === "groq")).toBe(true);
    expect(modelCatalogue("nothing-like-this")).toEqual([]);
  });
});

describe("contextWindowFor: the fallback chain", () => {
  it("prefers the catalogue", () => {
    expect(contextWindowFor({ provider: "openai", modelId: "gpt-4o" })).toBe(128_000);
    expect(contextWindowFor({ provider: "google-ai-studio", modelId: "gemini-1.5-pro" })).toBe(
      2_000_000,
    );
  });

  it("falls back to a local model's declared n_ctx", () => {
    expect(
      contextWindowFor(
        { provider: "local-llamacpp", modelId: "qwen2.5-coder-7b" },
        { "qwen2.5-coder-7b": 32_768 },
      ),
    ).toBe(32_768);
  });

  it("falls back to the default for a model nothing knows", () => {
    expect(contextWindowFor({ provider: "openai", modelId: "gpt-9-imaginary" })).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
    expect(contextWindowFor({ provider: "custom-thing", modelId: "" })).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("ignores a nonsense declared window rather than dividing by it", () => {
    // A `0`, a negative, or a `NaN` reaching the meter is a `NaN%` bar or a division
    // by zero somewhere downstream. Each is treated as "not declared".
    for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextWindowFor({ provider: "local-llamacpp", modelId: "m" }, { m: declared })).toBe(
        DEFAULT_CONTEXT_WINDOW,
      );
    }
  });

  it("keys on provider as well as model id", () => {
    // The same id under two providers is two different models with two different
    // windows — a Groq row and a local GGUF that happens to share a name.
    expect(contextWindowFor({ provider: "groq", modelId: "llama-3.3-70b-versatile" })).toBe(
      128_000,
    );
    expect(
      contextWindowFor({ provider: "local-llamacpp", modelId: "llama-3.3-70b-versatile" }),
    ).toBe(DEFAULT_CONTEXT_WINDOW);
  });

  it("does not confuse a model id containing the joiner", () => {
    expect(modelSpec("openai", "openai/gpt-oss-120b")).toBeNull();
    expect(modelSpec("groq", "openai/gpt-oss-120b")?.contextWindow).toBe(128_000);
  });
});
