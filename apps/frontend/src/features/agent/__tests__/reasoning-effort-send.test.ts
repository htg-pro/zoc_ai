// task 17.3 — the reasoning-effort field is present on a run request exactly
// when the run's provider can carry it, and omitted entirely otherwise. This
// pins the store-side send decision (buildReasoningEffortField ∘
// providerSupportsReasoningEffort) that sendUserMessage uses.
import { describe, expect, it } from "vitest";
import {
  REASONING_EFFORTS,
  buildReasoningEffortField,
  providerSupportsReasoningEffort,
} from "../composer-controls";

describe("reasoning-effort send decision (task 17.3)", () => {
  it("omits the field for local llama.cpp, the mock provider, and no provider", () => {
    for (const provider of [null, undefined, "", "llamacpp", "mock"]) {
      const supported = providerSupportsReasoningEffort(provider as string | null);
      expect(supported).toBe(false);
      for (const effort of REASONING_EFFORTS) {
        expect(buildReasoningEffortField(supported, effort)).toBeUndefined();
      }
    }
  });

  it("carries the selected effort for cloud reasoning providers", () => {
    for (const provider of ["openai", "anthropic", "google", "groq", "xai"]) {
      const supported = providerSupportsReasoningEffort(provider);
      expect(supported).toBe(true);
      for (const effort of REASONING_EFFORTS) {
        expect(buildReasoningEffortField(supported, effort)).toBe(effort);
      }
    }
  });
});
