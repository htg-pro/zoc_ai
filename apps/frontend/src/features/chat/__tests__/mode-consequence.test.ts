/**
 * The nine consequence sentences — zoc-agent-chat-rebuild R11.10, R32.1, R32.3, R32.4, task 20.2's guard.
 *
 * One assertion per (Conversation_Mode, Permission_Mode) pair, each checked against the Capability_Policy
 * verdicts the sentence describes. Exhaustive rather than sampled: nine cells is the entire domain, so
 * enumeration is both cheaper and stronger than any number of draws over it.
 *
 * ## What "the copy cannot drift from the gate" means as a test
 *
 * The sentences are not compared against expected strings — that would pin the prose and prove nothing
 * about the policy. Each is compared against what `checkCapability` says for the same mode: a sentence may
 * promise a change only where the policy permits one, must say the Approval axis is inert exactly where
 * nothing is permitted in either approval state, and must qualify `auto` with R11.6's forced approvals.
 * Rewording is free; promising something the gate refuses is not.
 */

import { describe, expect, it } from "vitest";
import { checkCapability } from "@zoc-studio/agent-runtime/policy";

import {
  CONVERSATION_MODES,
  PERMISSION_MODES,
  everyModePair,
  modeConsequence,
} from "@/features/chat/composer/mode-consequence";

describe("Feature: zoc-agent-chat-rebuild, task 20.2: the nine mode-consequence sentences", () => {
  it("covers every pair exactly once", () => {
    const pairs = everyModePair();
    expect(pairs).toHaveLength(CONVERSATION_MODES.length * PERMISSION_MODES.length);
    expect(new Set(pairs.map((pair) => `${pair.mode}:${pair.permissionMode}`)).size).toBe(9);
  });

  it("reads its capability flags straight from the policy", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      expect(consequence.mayChangeNow, label).toBe(
        checkCapability(mode, false, "write").permitted,
      );
      expect(consequence.mayChangeAfterPlanApproval, label).toBe(
        checkCapability(mode, true, "write").permitted,
      );
    }
  });

  it("promises a change only where the policy permits one", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      const canEverChange =
        consequence.mayChangeNow || consequence.mayChangeAfterPlanApproval;
      if (!canEverChange) {
        // The sentence must not imply a mutation the gate would refuse.
        expect(consequence.sentence, label).not.toMatch(/changes files|approve the plan/);
        expect(consequence.sentence, label).toContain("cannot change anything");
      }
    }
  });

  it("says the Approval axis is inert exactly where it is", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      const inert =
        !checkCapability(mode, false, "write").permitted &&
        !checkCapability(mode, true, "write").permitted;
      expect(consequence.approvalIsInert, label).toBe(inert);
      // Named rather than left out: a user who has just changed Approval and sees no difference in
      // behaviour needs to be told the control does not apply here rather than left to conclude it is
      // broken.
      expect(consequence.sentence.includes("Approval does not apply"), label).toBe(inert);
    }
  });

  it("gives the three Ask pairs one identical sentence, because the policy makes them identical", () => {
    const sentences = PERMISSION_MODES.map(
      (permissionMode) => modeConsequence("ask", permissionMode).sentence,
    );
    expect(new Set(sentences).size).toBe(1);
    // And the reason, stated as an assertion rather than a comment: nothing beyond `read` is permitted in
    // either approval state, so Permission_Mode has nothing to gate.
    for (const capability of ["write", "execute"] as const) {
      for (const approved of [false, true]) {
        expect(checkCapability("ask", approved, capability).permitted).toBe(false);
      }
    }
  });

  it("says changes are refused exactly under deny, and only where something could change", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      const shouldRefuse = permissionMode === "deny" && !consequence.approvalIsInert;
      expect(consequence.refusesChanges, label).toBe(shouldRefuse);
      expect(consequence.sentence.includes("refused"), label).toBe(shouldRefuse);
    }
  });

  it("qualifies auto with the forced approvals that survive it (R11.6)", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      const shouldQualify = permissionMode === "auto" && !consequence.approvalIsInert;
      // "without asking" is the claim a user most needs qualifying, and a destructive action still asks
      // whatever the mode says.
      expect(consequence.sentence.includes("Destructive actions still ask"), label).toBe(
        shouldQualify,
      );
    }
  });

  it("says an ask-mode pair asks, and an auto-mode pair does not", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      if (consequence.approvalIsInert) continue;
      if (permissionMode === "ask") {
        expect(consequence.asksFirst, label).toBe(true);
        expect(consequence.sentence, label).toMatch(/asks|ask again/);
      }
      if (permissionMode === "auto") {
        expect(consequence.asksFirst, label).toBe(false);
        expect(consequence.sentence, label).toContain("without asking");
      }
    }
  });

  it("distinguishes Plan's two-step gate from Agent's per-change one", () => {
    // The Plan sentences name the plan, because approving it is the step that unlocks the rest of the Run
    // (R32.9) — and a sentence that did not mention it would describe Agent.
    expect(modeConsequence("plan", "ask").sentence).toContain("approve the plan");
    expect(modeConsequence("plan", "auto").sentence).toContain("approve the plan");
    expect(modeConsequence("agent", "ask").sentence).not.toContain("plan");
    expect(modeConsequence("agent", "auto").sentence).not.toContain("plan");
  });

  it("produces one complete sentence per pair", () => {
    for (const { mode, permissionMode, consequence } of everyModePair()) {
      const label = `${mode}:${permissionMode}`;
      expect(consequence.sentence.length, label).toBeGreaterThan(20);
      expect(consequence.sentence.endsWith("."), label).toBe(true);
      // No identifier, no path: the line is rendered verbatim beside the composer.
      expect(consequence.sentence, label).not.toMatch(/[/\\]|run_|sess_/);
    }
  });
});
