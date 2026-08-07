/**
 * The host's one non-trivial decision: the model catalogue (task 25.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 25.6.
 *
 * `catalogueOf` pairs three independent lists — the provider registry, one pass of key states, and the
 * registered `.gguf` files — and the mistake it can make is pairing a key state with the wrong
 * provider, which is the failure `modelChoice`'s docstring names. That is arithmetic, so it is checked
 * as arithmetic rather than by mounting a picker.
 */
import { describe, expect, it } from "vitest";

import { catalogueOf } from "@/features/chat/ChatPanelHost";
import { isSubmittable } from "@/features/chat/header/model-catalogue";
import { DEFAULT_CONTEXT_WINDOW, type LocalModel } from "@/lib/local-models";
import type { ProviderConfig } from "@/lib/providers";

const KEYED: ProviderConfig = {
  id: "anthropic",
  name: "Anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  requiresKey: true,
  builtin: true,
  models: [{ id: "claude-opus-5", name: "Claude Opus 5", contextWindow: 200_000 }],
};

const KEYLESS: ProviderConfig = {
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  requiresKey: true,
  builtin: true,
  // No `contextWindow`, so this row exercises the fallback.
  models: [{ id: "gpt-5", name: "GPT-5" }],
};

const LOCAL: LocalModel = {
  id: "qwen-coder",
  name: "Qwen2.5 Coder",
  path: "/models/qwen.gguf",
  n_ctx: 32_768,
};

/** No `n_ctx`, which is the pre-existing entry the fallback exists for. */
const LOCAL_NO_CTX: LocalModel = { id: "tiny", name: "Tiny", path: "/models/tiny.gguf" };

describe("catalogueOf", () => {
  it("pairs each provider's key state with that provider's models only", () => {
    const models = catalogueOf(
      [KEYED, KEYLESS],
      new Map([
        [KEYED.id, true],
        [KEYLESS.id, false],
      ]),
      [],
    );

    expect(models.map((m) => [m.provider, m.hasKey])).toEqual([
      ["anthropic", true],
      ["openai", false],
    ]);
    // The pairing's whole consequence: one is submittable and the other is gated.
    expect(models.map(isSubmittable)).toEqual([true, false]);
  });

  it("treats an unanswered provider as keyless rather than as keyed", () => {
    // The map is empty while the first `providerKeyStates` read is in flight. A row that defaulted to
    // `true` would offer a Run that fails at the provider instead of at the composer.
    const [model] = catalogueOf([KEYED], new Map(), []);
    expect(model.hasKey).toBe(false);
    expect(isSubmittable(model)).toBe(false);
  });

  it("lists local models first, and they need no key", () => {
    const models = catalogueOf([KEYED], new Map([[KEYED.id, true]]), [LOCAL]);

    expect(models[0]).toMatchObject({
      provider: "llamacpp",
      modelId: "qwen-coder",
      label: "Qwen2.5 Coder",
      local: true,
      requiresKey: false,
      hasKey: true,
      contextLimit: 32_768,
    });
    expect(models[1].provider).toBe("anthropic");
  });

  it("falls back to the default context window when neither source states one", () => {
    const cloud = catalogueOf([KEYLESS], new Map(), []);
    const local = catalogueOf([], new Map(), [LOCAL_NO_CTX]);

    expect(cloud[0].contextLimit).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(local[0].contextLimit).toBe(DEFAULT_CONTEXT_WINDOW);
    // Stated, not assumed: a zero limit would make the context meter read "full" on an empty session.
    expect(DEFAULT_CONTEXT_WINDOW).toBeGreaterThan(0);
  });
});
