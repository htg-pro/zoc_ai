// Feature: zoc-ai-agent-chat-overhaul, Property 38: Non-ideal states name their cause and their next action
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type SurfaceError, surfaceState } from "../surface-state";
import { AGENT_MODES, modeRequiresWorkspace } from "../prepare-agent-run";

describe("surfaceState (Property 38)", () => {
  it("is uniquely determined by precedence and names cause + next action", () => {
    fc.assert(
      fc.property(
        fc.record({
          connected: fc.boolean(),
          historyLoading: fc.boolean(),
          workspaceRoot: fc.option(fc.constant("/ws"), { nil: null }),
          rowCount: fc.nat({ max: 5 }),
          selectedModel: fc.option(fc.constant("gpt-4o"), { nil: null }),
          mode: fc.constantFrom(...AGENT_MODES),
          lastError: fc.option(
            fc.record({
              operation: fc.string({ minLength: 1 }),
              code: fc.string({ minLength: 1 }),
              message: fc.string({ minLength: 1 }),
              retryable: fc.boolean(),
            }),
            { nil: null },
          ) as fc.Arbitrary<SurfaceError | null>,
        }),
        (input) => {
          const state = surfaceState(input);

          // Reference precedence.
          let expectedKind: string;
          if (input.historyLoading) expectedKind = "loading";
          else if (!input.connected) expectedKind = "disconnected";
          else if (input.lastError) expectedKind = "error";
          else if ((input.workspaceRoot ?? "").length === 0 && modeRequiresWorkspace(input.mode))
            expectedKind = "workspace-required";
          else if (input.rowCount === 0) expectedKind = "empty";
          else expectedKind = "transcript";
          expect(state.kind).toBe(expectedKind);

          if (state.kind === "empty") {
            expect(state.model.length).toBeGreaterThan(0);
            expect(state.mode).toBe(input.mode);
            expect(state.examples.length).toBeGreaterThanOrEqual(1);
          }
          if (state.kind === "workspace-required") {
            expect(state.action).toBe("open-folder");
          }
          if (state.kind === "error") {
            expect(state.operation).toBe(input.lastError?.operation);
            expect(state.code).toBe(input.lastError?.code);
            expect(state.message).toBe(input.lastError?.message);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
