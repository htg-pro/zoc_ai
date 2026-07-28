// Feature: zoc-ai-agent-chat-overhaul, Property 42: Reasoning-effort support is model-specific and mirrors the Gateway
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  modelSupportsReasoningEffort,
  reasoningEffortCapability,
} from "../composer-controls";

describe("reasoningEffortCapability (model-specific, mirrors gateway)", () => {
  it("classifies known model families exactly like the Gateway", () => {
    // OpenAI-compatible reasoning markers.
    expect(reasoningEffortCapability("openai", "o1")).toBe("openai");
    expect(reasoningEffortCapability("openai", "o3-mini")).toBe("openai");
    expect(reasoningEffortCapability("openai", "gpt-5")).toBe("openai");
    expect(reasoningEffortCapability("groq", "deepseek-r1-distill")).toBe("openai");
    expect(reasoningEffortCapability("llamacpp", "qwq-32b-q4")).toBe("openai");
    // Non-reasoning models on compatible providers.
    expect(reasoningEffortCapability("openai", "gpt-4o")).toBe("none");
    expect(reasoningEffortCapability("llamacpp", "qwen2.5-coder-7b")).toBe("none");
    // Anthropic versions.
    expect(reasoningEffortCapability("anthropic", "claude-opus-4-6")).toBe("anthropic_adaptive");
    expect(reasoningEffortCapability("anthropic", "claude-sonnet-4-0")).toBe("anthropic_budget");
    expect(reasoningEffortCapability("anthropic", "claude-3-7-sonnet")).toBe("anthropic_budget");
    expect(reasoningEffortCapability("anthropic", "claude-3-5-sonnet")).toBe("none");
    // Mock / empty.
    expect(reasoningEffortCapability("mock", "mock-model")).toBe("none");
    expect(reasoningEffortCapability("openai", "")).toBe("none");
  });

  it("modelSupportsReasoningEffort agrees with capability !== none (>=100 runs)", () => {
    const providers = ["openai", "anthropic", "groq", "xai", "llamacpp", "mock", "google"];
    const models = [
      "o1",
      "o3",
      "gpt-5",
      "gpt-4o",
      "qwq-32b",
      "deepseek-r1",
      "qwen2.5-coder",
      "claude-opus-4-6",
      "claude-3-7-sonnet",
      "claude-3-5-sonnet",
      "",
    ];
    fc.assert(
      fc.property(fc.constantFrom(...providers), fc.constantFrom(...models), (p, m) => {
        expect(modelSupportsReasoningEffort(p, m)).toBe(reasoningEffortCapability(p, m) !== "none");
      }),
      { numRuns: 150 },
    );
  });

  it("is stable and total for arbitrary strings (never throws)", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (p, m) => {
        const cap = reasoningEffortCapability(p, m);
        expect(["openai", "anthropic_adaptive", "anthropic_budget", "none"]).toContain(cap);
        expect(reasoningEffortCapability(p, m)).toBe(cap);
      }),
      { numRuns: 150 },
    );
  });
});
