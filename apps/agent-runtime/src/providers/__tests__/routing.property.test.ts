/** Property 67: routing selects the first available model in the chain (R27.4–R27.6). */
/** Feature: zoc-agent-chat-rebuild, Property 67 (R27.4, R27.5, R27.6). */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  ModelRoutingExhaustedError,
  executeModelChain,
  type ModelFallbackNotice,
  type ModelRef,
} from "../registry.ts";

const chainOf = (length: number): ModelRef[] =>
  Array.from({ length }, (_, index) => ({ provider: "openai", modelId: `model-${String(index)}` }));

describe("Property 67: model routing selects the first available model", () => {
  it("skips any failing prefix and emits one complete notice per fallback", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 12 }),
        fc.nat({ max: 11 }),
        fc.constantFrom("provider_rate_limited", "model_unavailable"),
        async (length, failureSeed, code) => {
          const chain = chainOf(length);
          const failures = failureSeed % length;
          const notices: ModelFallbackNotice[] = [];
          const result = await executeModelChain({
            chain,
            attempt: async (model) => {
              const index = Number(model.modelId.split("-")[1]);
              if (index < failures) throw { code, message: `${model.modelId} unavailable` };
              return model.modelId;
            },
            classify: (error) => error as { code: string; message: string },
            onFallback: (notice) => notices.push(notice),
          });

          expect(result.selected).toEqual(chain[failures]);
          expect(result.value).toBe(chain[failures]?.modelId);
          expect(notices).toHaveLength(failures);
          notices.forEach((notice, index) => {
            expect(notice.original).toEqual(chain[index]);
            expect(notice.fallback).toEqual(chain[index + 1]);
            expect(notice.reason).toContain(chain[index]?.modelId);
          });
        },
      ),
      { numRuns: 150 },
    );
  });

  it("normalises complete exhaustion to model_unavailable", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (length) => {
        await expect(
          executeModelChain({
            chain: chainOf(length),
            attempt: async () => {
              throw new Error("down");
            },
            classify: () => ({ code: "model_unavailable", message: "unavailable" }),
          }),
        ).rejects.toMatchObject({
          code: "model_unavailable",
        } satisfies Partial<ModelRoutingExhaustedError>);
      }),
      { numRuns: 60 },
    );
  });
});
