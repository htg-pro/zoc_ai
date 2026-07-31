/**
 * Property 30: Submission gating is a function of key state alone. R13.2, R13.3, R13.4.
 *
 * *For any* model, whether a Run can be submitted depends on `requiresKey` and `hasKey` and on nothing else.
 * Two models differing in every other field — provider, label, context window, hardware fit, benchmark
 * history — gate identically.
 *
 * ## Why "and on nothing else" is the clause worth generating over
 *
 * The plausible implementations all add a second condition, and each one blocks a Run that would have
 * worked: gating on a *validated* key blocks while validation is in flight, gating on the last Run's outcome
 * blocks after an unrelated failure, gating on reachability blocks on a flaky network. So the property
 * asserts invariance across every other field rather than asserting the two true cases, which any of those
 * implementations would also pass.
 *
 * ## Why a local model is the case a refusal-shaped gate gets backwards
 *
 * "Block unless a key exists" is the obvious reading and it makes every local model unusable. A model served
 * by the bundled `llama-server` needs no key, so `requiresKey: false` is submittable whatever the vault says
 * — asserted explicitly, because it is the one branch a keyless test corpus would never reach.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  FIT_LABELS,
  formatMeanRate,
  gateReasonOf,
  groupByProvider,
  isSubmittable,
  keyBadgeOf,
  modelChoice,
  type HardwareFit,
  type ModelChoice,
} from "@/features/chat/header/model-catalogue";

const RUNS = { numRuns: 200 } as const;

const fit: fc.Arbitrary<HardwareFit> = fc.constantFrom("fits", "tight", "exceeds");

/** A model choice with everything *except* the two gating fields drawn freely. */
const choiceWith = (requiresKey: boolean, hasKey: boolean): fc.Arbitrary<ModelChoice> =>
  fc
    .record({
      provider: fc.constantFrom("anthropic", "openai", "groq", "local-llamacpp"),
      providerLabel: fc.constantFrom("Anthropic", "OpenAI", "Groq", "Local"),
      modelId: fc.hexaString({ minLength: 3, maxLength: 12 }),
      label: fc.stringMatching(/^[A-Za-z][A-Za-z0-9 .-]{2,20}$/),
      local: fc.boolean(),
      fit: fc.option(fit, { nil: undefined }),
      meanTokensPerSecond: fc.option(fc.double({ min: 0, max: 400, noNaN: true }), {
        nil: undefined,
      }),
      contextLimit: fc.integer({ min: 4_096, max: 1_000_000 }),
    })
    .map((fields) => ({ ...fields, requiresKey, hasKey }));

describe("Feature: zoc-agent-chat-rebuild, Property 30: submission gating is a function of key state alone", () => {
  it("gates on the two key fields and ignores every other field (R13.2, R13.3)", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (requiresKey, hasKey, seedA, seedB) => {
          // Two arbitrary models sharing only the gating pair. Their verdicts must agree.
          const first = fc.sample(choiceWith(requiresKey, hasKey), { numRuns: 1, seed: Number(seedA) })[0];
          const second = fc.sample(choiceWith(requiresKey, hasKey), { numRuns: 1, seed: Number(seedB) })[0];
          expect(first).toBeDefined();
          expect(second).toBeDefined();
          if (first === undefined || second === undefined) return;

          expect(isSubmittable(first)).toBe(isSubmittable(second));
          // And the verdict is the one the two fields imply, with no third condition.
          expect(isSubmittable(first)).toBe(!requiresKey || hasKey);
        },
      ),
      RUNS,
    );
  });

  it("permits a model that needs no key, whatever the vault says (R13.4)", () => {
    fc.assert(
      fc.property(choiceWith(false, false), choiceWith(false, true), (without, with_) => {
        // The branch a refusal-shaped gate gets backwards: a local model is usable with no key at all.
        expect(isSubmittable(without)).toBe(true);
        expect(isSubmittable(with_)).toBe(true);
        expect(keyBadgeOf(without)).toBeNull();
        expect(gateReasonOf(without)).toBeNull();
      }),
      RUNS,
    );
  });

  it("blocks a keyless cloud model and says which provider needs the key (R13.3)", () => {
    fc.assert(
      fc.property(choiceWith(true, false), (model) => {
        expect(isSubmittable(model)).toBe(false);
        expect(keyBadgeOf(model)).toBe("key-missing");

        const reason = gateReasonOf(model);
        expect(reason).not.toBeNull();
        // The provider, because the key is per provider: naming the model would send a user looking for a
        // per-model setting that does not exist.
        expect(reason).toContain(model.providerLabel);
        expect(reason).not.toContain(model.modelId);
      }),
      RUNS,
    );
  });

  it("shows no badge for a cloud model that has a key", () => {
    fc.assert(
      fc.property(choiceWith(true, true), (model) => {
        // The absence of the warning is the signal; a tick on every configured row is decoration.
        expect(keyBadgeOf(model)).toBeNull();
        expect(isSubmittable(model)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("the picker's other three facts (R13.6, R13.11, R13.12, R13.13)", () => {
  it("omits the rate entirely for a model with no usable history (R13.12)", () => {
    fc.assert(
      fc.property(choiceWith(true, true), (model) => {
        for (const rate of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
          // Not a dash, not "unknown": nothing. A placeholder reads as a measurement of zero.
          expect(
            formatMeanRate({ ...model, meanTokensPerSecond: rate as number | undefined }),
          ).toBeNull();
        }
        expect(formatMeanRate({ ...model, meanTokensPerSecond: 42 })).toBe("42 tok/s");
        // The same decimal threshold the live figure uses, so the two never disagree about whole numbers.
        expect(formatMeanRate({ ...model, meanTokensPerSecond: 24.7 })).toBe("24.7 tok/s");
        expect(formatMeanRate({ ...model, meanTokensPerSecond: 124.3 })).toBe("124 tok/s");
      }),
      RUNS,
    );
  });

  it("names each fit state in words (R13.6, R21.7)", () => {
    for (const state of ["fits", "tight", "exceeds"] as const) {
      expect(FIT_LABELS[state].length).toBeGreaterThan(4);
    }
    // Three distinct sentences, so the state survives without colour.
    expect(new Set(Object.values(FIT_LABELS)).size).toBe(3);
  });

  it("groups by provider in the catalogue's own order", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom("b-provider", "a-provider", "c-provider"), fc.hexaString({ minLength: 2, maxLength: 6 })), {
          minLength: 1,
          maxLength: 12,
        }),
        (entries) => {
          const models = entries.map(([provider, id], index) =>
            modelChoice({
              provider,
              providerLabel: provider.toUpperCase(),
              model: { id: `${id}${String(index)}`, name: `Model ${String(index)}` },
              requiresKey: true,
              hasKey: true,
              local: false,
              contextLimit: 8_192,
            }),
          );
          const groups = groupByProvider(models);

          // First appearance wins, and no group is empty: re-sorting would move the provider a user uses
          // most away from where they left it.
          const firstAppearance = [...new Set(models.map((model) => model.provider))];
          expect(groups.map((group) => group.provider)).toEqual(firstAppearance);
          expect(groups.every((group) => group.models.length > 0)).toBe(true);
          expect(groups.reduce((total, group) => total + group.models.length, 0)).toBe(models.length);
        },
      ),
      RUNS,
    );
  });

  it("falls back to the wire id when a catalogue entry has no name", () => {
    const model = modelChoice({
      provider: "openai",
      providerLabel: "OpenAI",
      model: { id: "gpt-x", name: "   " },
      requiresKey: true,
      hasKey: false,
      local: false,
      contextLimit: 128_000,
    });
    // A blank row is worse than a technical one.
    expect(model.label).toBe("gpt-x");
  });
});
