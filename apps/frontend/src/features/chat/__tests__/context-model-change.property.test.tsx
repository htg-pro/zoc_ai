/**
 * Property 83: No context figure is displayed against another model's limit. R12.9, R12.10.
 *
 * *For any* sequence of model changes, **every committed render** of the meter pairs its token figures with
 * the limit of the model named in that same render — and a figure the runtime has not measured against the
 * current model is marked as an estimate.
 *
 * ## Why a render recorder rather than an end-state read
 *
 * The requirement is about a transient: an implementation that recomputed the figures in an effect would
 * paint one frame of the previous model's count against the new model's limit, and then correct itself. An
 * assertion over the final DOM sees only the corrected state and passes. One frame is enough for a
 * screenshot, for a screen reader, and for a user watching the number — so the property observes every
 * commit through a `MutationObserver` and checks each one.
 *
 * The recorder is why the meter writes its model, its limit, and its consumed figure onto **one** element:
 * three attributes changed in one commit are one observable state, and a reader — human or test — cannot
 * catch them disagreeing.
 *
 * ## What "estimate" means here
 *
 * Two situations mark the figures as an estimate (R12.9), and the second is the one a naive implementation
 * misses: no `UsagePart` at all, and a `UsagePart` that exists but was measured against the *previous*
 * model. The second is why `ContextCensus.measuredAgainst` is a model reference rather than a boolean.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { ContextMeter } from "@/features/chat/composer/ContextMeter";
import type { ContextCensus, ModelReference } from "@/features/chat/composer/context-figures";
import { resetChatSurface } from "./transcript-harness";

/** Three models with distinct windows, so a stale limit is detectable rather than coincidentally right. */
const MODELS: readonly ModelReference[] = [
  { provider: "anthropic", modelId: "claude-opus-5", contextLimit: 200_000 },
  { provider: "openai", modelId: "gpt-x", contextLimit: 128_000 },
  { provider: "local-llamacpp", modelId: "qwen-z", contextLimit: 8_192 },
];

const LIMIT_BY_ID = new Map(MODELS.map((model) => [model.modelId, model.contextLimit]));

interface Observation {
  readonly modelId: string;
  readonly limit: number;
  readonly consumed: number;
  readonly estimated: boolean;
}

beforeEach(() => {
  resetChatSurface();
});

afterEach(cleanup);

function censusFor(model: ModelReference | null, consumedTokens: number): ContextCensus {
  return {
    messagesInContext: 12,
    sessionMessageCount: 40,
    messagesOutOfWindow: 28,
    summaryActive: false,
    consumedTokens,
    measuredAgainst: model,
  };
}

/**
 * Render the meter and record every commit that touches its figures.
 *
 * The observer reads all three attributes when it fires rather than trusting the individual mutation
 * records, because what the property is about is the *combination* — and the combination is only
 * well-defined after the batch that wrote it.
 */
function recorder(initial: { model: ModelReference; census: ContextCensus }) {
  const observations: Observation[] = [];

  const tree = (model: ModelReference, census: ContextCensus) => (
    <ChatMotionProvider budget={null}>
      <ContextMeter
        model={model}
        census={census}
        mentions={[]}
        onRemoveMentions={() => undefined}
      />
    </ChatMotionProvider>
  );

  const view = render(tree(initial.model, initial.census));

  const meter = view.container.querySelector("[data-zoc-context-meter]");
  if (!(meter instanceof HTMLElement)) throw new Error("no meter");

  const read = (): Observation => ({
    modelId: meter.getAttribute("data-zoc-context-model") ?? "",
    limit: Number(meter.getAttribute("data-zoc-context-limit") ?? "0"),
    consumed: Number(meter.getAttribute("data-zoc-context-consumed") ?? "0"),
    estimated: meter.hasAttribute("data-zoc-context-estimated"),
  });

  // The first paint counts: a wrong pairing there is as visible as a wrong pairing later.
  observations.push(read());

  const observer = new MutationObserver(() => {
    observations.push(read());
  });
  observer.observe(meter, {
    attributes: true,
    attributeFilter: [
      "data-zoc-context-model",
      "data-zoc-context-limit",
      "data-zoc-context-consumed",
      "data-zoc-context-estimated",
    ],
  });

  return {
    observations,
    async select(model: ModelReference, census: ContextCensus) {
      // `async act` flushes the microtask the observer's callback is delivered on, so a commit cannot slip
      // past the recorder.
      await act(async () => {
        view.rerender(tree(model, census));
        await Promise.resolve();
      });
    },
    stop() {
      observer.disconnect();
      view.unmount();
    },
  };
}

describe("Feature: zoc-agent-chat-rebuild, Property 83: no context figure is displayed against another model's limit", () => {
  it("pairs every committed figure with its own model's window (R12.10)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 2, maxLength: 8 }),
        fc.array(fc.integer({ min: 500, max: 150_000 }), { minLength: 2, maxLength: 8 }),
        async (picks, consumptions) => {
          cleanup();
          const first = MODELS[picks[0] ?? 0] ?? MODELS[0];
          if (first === undefined) return;
          const harness = recorder({
            model: first,
            census: censusFor(first, consumptions[0] ?? 1_000),
          });

          for (const [step, pick] of picks.entries()) {
            const model = MODELS[pick] ?? MODELS[0];
            if (model === undefined) continue;
            // The census still names the *previous* model, which is what a real model switch looks like:
            // the last `UsagePart` was measured before the change.
            const previous = MODELS[picks[step - 1] ?? pick] ?? null;
            await harness.select(model, censusFor(previous, consumptions[step] ?? 1_000));
          }

          expect(harness.observations.length).toBeGreaterThan(0);
          for (const observation of harness.observations) {
            expect(
              observation.limit,
              `${observation.modelId} was shown against ${String(observation.limit)}`,
            ).toBe(LIMIT_BY_ID.get(observation.modelId));
          }

          harness.stop();
        },
      ),
      { numRuns: 25 },
    );
  });

  it("marks the figures as an estimate until the runtime measures the new model (R12.9)", async () => {
    const [opus, gpt] = MODELS;
    if (opus === undefined || gpt === undefined) return;

    const harness = recorder({ model: opus, census: censusFor(opus, 12_000) });
    // Measured against the model on screen: not an estimate.
    expect(harness.observations.at(-1)?.estimated).toBe(false);

    // A model change with the same census: the figures are now about a different window, and the meter
    // says so rather than presenting the old count as measured.
    await harness.select(gpt, censusFor(opus, 12_000));
    expect(harness.observations.at(-1)?.estimated).toBe(true);
    expect(harness.observations.at(-1)?.limit).toBe(gpt.contextLimit);

    // A `UsagePart` for the new model clears the mark.
    await harness.select(gpt, censusFor(gpt, 9_000));
    expect(harness.observations.at(-1)?.estimated).toBe(false);

    // And no observation along the way paired a figure with the wrong window.
    for (const observation of harness.observations) {
      expect(observation.limit).toBe(LIMIT_BY_ID.get(observation.modelId));
    }
    harness.stop();
  });

  it("never reports a limit from before a switch, even for one commit", async () => {
    const [opus, , qwen] = MODELS;
    if (opus === undefined || qwen === undefined) return;

    // The regression this property exists for: 200k → 8k is the switch where a stale limit is most
    // consequential, because the same count is comfortable under one and overflowing under the other.
    const harness = recorder({ model: opus, census: censusFor(opus, 100_000) });
    await harness.select(qwen, censusFor(opus, 100_000));

    const seen = harness.observations.map(
      (observation) => `${observation.modelId}:${String(observation.limit)}`,
    );
    expect(seen).not.toContain(`${qwen.modelId}:${String(opus.contextLimit)}`);
    expect(seen).not.toContain(`${opus.modelId}:${String(qwen.contextLimit)}`);
    harness.stop();
  });
});
