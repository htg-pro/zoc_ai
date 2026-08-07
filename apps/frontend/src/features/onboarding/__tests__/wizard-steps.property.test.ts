// Feature: zoc-ai-agent-chat-overhaul, Property 4: Onboarding commits the workspace before it advances
// Feature: zoc-ai-agent-chat-overhaul, Property 5: Onboarding continue is gated on sidecar readiness
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type SidecarPhase,
  type SidecarWait,
  type WizardState,
  SIDECAR_READINESS_DEADLINE_MS,
  canonicalizeWorkspace,
  commitWorkspaceStep,
  reduceSidecarWait,
} from "../wizard-steps";

function workspaceState(workspace: string): WizardState {
  return {
    step: "workspace",
    workspace,
    modelChoice: null,
    modelPath: "",
    cloudProvider: "openai",
    cloudKey: "",
    telemetry: false,
  };
}

describe("commitWorkspaceStep (Property 4)", () => {
  it("persists + mirrors the identical canonical path, reloads, then advances last", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map((s) => `/${s.replace(/\s+$/, "")}/proj`),
        (rawPath) => {
          const effects = commitWorkspaceStep(workspaceState(rawPath));
          const canonical = canonicalizeWorkspace(rawPath);

          const persist = effects.find((e) => e.kind === "persist-workspace");
          const mirror = effects.find((e) => e.kind === "mirror-workspace");
          const reloadIdx = effects.findIndex((e) => e.kind === "reload-explorer");

          expect(persist).toBeDefined();
          expect(mirror).toBeDefined();
          if (persist?.kind === "persist-workspace" && mirror?.kind === "mirror-workspace") {
            expect(persist.root).toBe(canonical);
            expect(mirror.root).toBe(canonical);
          }
          // reload comes after persist + mirror.
          const persistIdx = effects.findIndex((e) => e.kind === "persist-workspace");
          const mirrorIdx = effects.findIndex((e) => e.kind === "mirror-workspace");
          expect(reloadIdx).toBeGreaterThan(persistIdx);
          expect(reloadIdx).toBeGreaterThan(mirrorIdx);
          // advance is last.
          expect(effects[effects.length - 1].kind).toBe("advance");
        },
      ),
      { numRuns: 200 },
    );
  });

  it("skipping (empty path) advances with no workspace commit", () => {
    const effects = commitWorkspaceStep(workspaceState("   "));
    expect(effects).toHaveLength(1);
    expect(effects[0].kind).toBe("advance");
  });
});

describe("reduceSidecarWait (Property 5)", () => {
  it("enables continue only when ready; waiting carries a reason; deadline yields retryable failure", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({
              kind: fc.constant("phase" as const),
              phase: fc.constantFrom<SidecarPhase>("starting", "restarting", "ready", "error"),
              detail: fc.option(fc.string(), { nil: undefined }),
            }),
            fc.record({ kind: fc.constant("tick" as const) }),
          ),
          { maxLength: 25 },
        ),
        (events) => {
          let state: SidecarWait = { kind: "idle" };
          let t = 0;
          for (const e of events) {
            t += 5_000;
            state = reduceSidecarWait(
              state,
              e.kind === "phase"
                ? { kind: "phase", phase: e.phase, detail: e.detail, nowMs: t }
                : { kind: "tick", nowMs: t },
            );
            if (state.kind === "waiting") {
              expect(state.reason.trim().length).toBeGreaterThan(0);
            }
            if (state.kind === "failed") {
              expect(state.retryable).toBe(true);
              expect(state.reason.trim().length).toBeGreaterThan(0);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("elapsing the deadline without a ready event fails retryably", () => {
    let state: SidecarWait = { kind: "idle" };
    state = reduceSidecarWait(state, { kind: "phase", phase: "restarting", nowMs: 0 });
    expect(state.kind).toBe("waiting");
    state = reduceSidecarWait(state, { kind: "tick", nowMs: SIDECAR_READINESS_DEADLINE_MS });
    expect(state.kind).toBe("failed");
    if (state.kind === "failed") expect(state.retryable).toBe(true);
  });

  it("a ready phase enables continue", () => {
    const state = reduceSidecarWait(
      { kind: "waiting", reason: "x", sinceMs: 0 },
      {
        kind: "phase",
        phase: "ready",
        nowMs: 100,
      },
    );
    expect(state.kind).toBe("ready");
  });
});
