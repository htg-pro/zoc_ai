// Feature: zoc-ai-agent-chat-overhaul, Property 32: Composer controls reflect selection, run activity, and read-only mode
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { REASONING_EFFORTS, composerControls } from "../composer-controls";
import { AGENT_MODES } from "../prepare-agent-run";
import type { RunGate } from "../model-availability";

const okGate: RunGate = { canStart: true };

describe("composerControls (Property 32)", () => {
  it("offers all modes and efforts, locks while a run is active or read-only, shows the active mode", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AGENT_MODES),
        fc.option(fc.constantFrom(...AGENT_MODES), { nil: null }),
        fc.constantFrom(...REASONING_EFFORTS),
        fc.boolean(),
        fc.boolean(),
        (mode, activeRunMode, effort, modelSupportsEffort, readOnly) => {
          const controls = composerControls({
            mode,
            activeRunMode,
            effort,
            modelSupportsEffort,
            readOnly,
            gate: okGate,
          });

          // All three options offered, current selection present.
          expect(controls.mode.options).toEqual(AGENT_MODES);
          expect(controls.effort.options).toEqual(REASONING_EFFORTS);
          expect(controls.effort.value).toBe(effort);

          const runActive = activeRunMode !== null;
          if (runActive) {
            // Locked and showing the active run's mode.
            expect(controls.mode.disabled).toBe(true);
            expect(controls.effort.disabled).toBe(true);
            expect(controls.mode.value).toBe(activeRunMode);
          } else {
            expect(controls.mode.value).toBe(mode);
          }

          if (readOnly) {
            expect(controls.mode.disabled).toBe(true);
            expect(controls.effort.disabled).toBe(true);
          }

          expect(controls.effort.supported).toBe(modelSupportsEffort);
          if (!modelSupportsEffort) expect(controls.effort.disabled).toBe(true);

          expect(controls.send).toBe(okGate);
        },
      ),
      { numRuns: 200 },
    );
  });
});
