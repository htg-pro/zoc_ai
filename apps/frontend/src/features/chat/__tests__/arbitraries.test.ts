/**
 * Guards on the Chat_Surface generators themselves.
 *
 * A property test is only as good as its generator: an arbitrary that quietly
 * stops producing terminal parts, or overlapping hunks, or roots that differ by
 * case, turns a passing property into a vacuous one. These tests sample each
 * generator and assert the invariant its own doc comment claims, so a
 * regression in the generator surfaces here rather than as a property that
 * passes for the wrong reason.
 *
 * Sampling uses a fixed seed wherever an assertion is about *coverage* rather
 * than about every draw, so the coverage checks cannot flake.
 *
 * Feature: zoc-agent-chat-rebuild
 * Requirements: 22.2
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { MessagePart, RunLifecyclePart } from "@zoc-studio/shared-types";

import {
  CONVERSATION_MODES,
  MARKDOWN_BODIES,
  PERMISSION_MODES,
  RETIRED_ROUTER_EDIT_TRIGGERS,
  RETIRED_ROUTER_QUESTION_TRIGGERS,
  RETIRED_ROUTER_TRIGGERS,
  TERMINAL_RUN_STATES,
  diffPart,
  draftAndMode,
  lifecycleActions,
  runPartSequence,
  sessionHistory,
  truncatedMarkdown,
  unreliableDelivery,
  workspaceRoot,
} from "./arbitraries";

const SEED = 20260226;

const isTerminalLifecycle = (part: MessagePart): part is RunLifecyclePart =>
  part.type === "run-lifecycle" && (TERMINAL_RUN_STATES as readonly string[]).includes(part.state);

describe("runPartSequence", () => {
  it("numbers every part 1..n with no gap and no repeat (R22.2)", () => {
    for (const parts of fc.sample(runPartSequence, { numRuns: 200, seed: SEED })) {
      expect(parts.length).toBeGreaterThan(0);
      expect(parts.map((part) => part.seq)).toEqual(parts.map((_, i) => i + 1));
    }
  });

  it("carries at most one terminal lifecycle part, and it is last (R22.2)", () => {
    let withTerminal = 0;
    for (const parts of fc.sample(runPartSequence, { numRuns: 200, seed: SEED })) {
      const terminals = parts.filter(isTerminalLifecycle);
      expect(terminals.length).toBeLessThanOrEqual(1);
      if (terminals.length === 1) {
        withTerminal += 1;
        expect(parts[parts.length - 1]).toBe(terminals[0]);
      }
    }
    // Both branches have to be reachable or half the invariant is untested.
    expect(withTerminal).toBeGreaterThan(0);
    expect(withTerminal).toBeLessThan(200);
  });

  it("keeps one runId and one messageId across the sequence", () => {
    for (const parts of fc.sample(runPartSequence, { numRuns: 50, seed: SEED })) {
      expect(new Set(parts.map((part) => part.runId)).size).toBe(1);
      expect(new Set(parts.map((part) => part.messageId)).size).toBe(1);
    }
  });
});

describe("unreliableDelivery", () => {
  it("delivers only intended parts, and only up to the disconnect (R22.2)", () => {
    for (const delivery of fc.sample(unreliableDelivery, { numRuns: 200, seed: SEED })) {
      const intendedSeqs = new Set(delivery.intended.map((part) => part.seq));
      for (const part of delivery.delivered) expect(intendedSeqs.has(part.seq)).toBe(true);
      if (delivery.disconnectAfterIndex !== null) {
        expect(delivery.delivered.length).toBe(delivery.disconnectAfterIndex + 1);
      }
    }
  });

  it("reports the resume seq as the highest gapless prefix delivered", () => {
    for (const delivery of fc.sample(unreliableDelivery, { numRuns: 200, seed: SEED })) {
      const seen = new Set(delivery.delivered.map((part) => part.seq));
      for (let seq = 1; seq <= delivery.resumeFromSeq; seq += 1) {
        expect(seen.has(seq)).toBe(true);
      }
      expect(seen.has(delivery.resumeFromSeq + 1)).toBe(false);
    }
  });

  it("produces all three hazards: duplication, reordering, and a mid-stream cut", () => {
    const samples = fc.sample(unreliableDelivery, { numRuns: 300, seed: SEED });
    const duplicated = samples.some(
      (d) => new Set(d.delivered.map((p) => p.seq)).size < d.delivered.length,
    );
    const reordered = samples.some((d) =>
      d.delivered.some((part, index) => index > 0 && part.seq < d.delivered[index - 1].seq),
    );
    const cut = samples.some((d) => d.disconnectAfterIndex !== null);
    expect({ duplicated, reordered, cut }).toEqual({
      duplicated: true,
      reordered: true,
      cut: true,
    });
  });

  it("bounds reordering displacement by the window it reports", () => {
    for (const delivery of fc.sample(unreliableDelivery, { numRuns: 100, seed: SEED })) {
      // Displacement is measured against the pre-shuffle order, which duplication
      // preserves, so a part's observed index cannot run ahead of its seq by more
      // than the window.
      for (const [index, part] of delivery.delivered.entries()) {
        expect(part.seq - (index + 1)).toBeLessThanOrEqual(delivery.reorderWindow);
      }
    }
  });
});

describe("diffPart", () => {
  it("carries 1–20 hunks whose line ranges do not overlap (R22.2)", () => {
    for (const part of fc.sample(diffPart, { numRuns: 200, seed: SEED })) {
      expect(part.hunks.length).toBeGreaterThanOrEqual(1);
      expect(part.hunks.length).toBeLessThanOrEqual(20);
      let previousEnd = 0;
      for (const hunk of part.hunks) {
        expect(hunk.oldStart).toBeGreaterThan(previousEnd);
        previousEnd = hunk.oldStart + hunk.oldLines;
      }
      expect(new Set(part.hunks.map((hunk) => hunk.hunkId)).size).toBe(part.hunks.length);
    }
  });

  it("sets sourcePath for a rename and for nothing else", () => {
    const samples = fc.sample(diffPart, { numRuns: 200, seed: SEED });
    for (const part of samples) {
      expect(part.sourcePath !== null).toBe(part.action === "rename");
    }
    expect(new Set(samples.map((part) => part.action))).toEqual(new Set(["modify", "rename"]));
  });
});

describe("truncatedMarkdown", () => {
  it("produces only prefixes of valid markdown documents (R22.2)", () => {
    for (const sample of fc.sample(truncatedMarkdown, { numRuns: 300, seed: SEED })) {
      expect(MARKDOWN_BODIES.some((body) => body.startsWith(sample))).toBe(true);
    }
  });

  it("reaches an unclosed fence, a dangling emphasis, and a half-written link", () => {
    const samples = fc.sample(truncatedMarkdown, { numRuns: 500, seed: SEED });
    const unclosedFence = samples.some((s) => (s.match(/```/g) ?? []).length % 2 === 1);
    const danglingEmphasis = samples.some((s) => (s.match(/\*\*/g) ?? []).length % 2 === 1);
    const halfLink = samples.some((s) => s.lastIndexOf("[") > s.lastIndexOf(")"));
    expect({ unclosedFence, danglingEmphasis, halfLink }).toEqual({
      unclosedFence: true,
      danglingEmphasis: true,
      halfLink: true,
    });
  });
});

describe("sessionHistory", () => {
  it("builds a Session of 0–120 messages with 0–4 well-formed folds (R22.2)", () => {
    for (const fixture of fc.sample(sessionHistory, { numRuns: 200, seed: SEED })) {
      const { session, compactions } = fixture;
      expect(session.messages.length).toBeGreaterThanOrEqual(0);
      expect(session.messages.length).toBeLessThanOrEqual(120);
      expect(compactions.length).toBeLessThanOrEqual(4);

      const ids = session.messages.map((message) => message.id);
      expect(new Set(ids).size).toBe(ids.length);

      let previousPosition = -1;
      for (const { afterMessageIndex, part } of compactions) {
        expect(afterMessageIndex).toBeGreaterThan(previousPosition);
        previousPosition = afterMessageIndex;
        expect(afterMessageIndex).toBeLessThan(session.messages.length);
        // Folds a prefix, accumulating: a later fold's ids are a superset.
        expect(part.foldedMessageIds).toEqual(ids.slice(0, afterMessageIndex + 1));
        expect(part.foldedMessageIds.length).toBeGreaterThan(0);
        expect(part.foldedTurnCount).toBeGreaterThanOrEqual(1);
        expect(part.contextTokensAfter).toBeLessThanOrEqual(part.contextTokensBefore);
        expect(part.seq).toBeGreaterThanOrEqual(1);
      }

      // A Session with no messages has nothing to fold.
      if (session.messages.length === 0) expect(compactions).toHaveLength(0);
    }
  });

  it("draws roots with trailing-separator and case variants (R22.2)", () => {
    const roots = fc.sample(workspaceRoot, { numRuns: 300, seed: SEED });
    expect(roots.some((root) => root.endsWith("/"))).toBe(true);
    expect(roots.some((root) => !root.endsWith("/"))).toBe(true);
    // The pair that a raw-string comparison passes and a canonicalising one does
    // not: same path, different case.
    const lowered = new Set(roots.map((root) => root.toLowerCase()));
    expect(lowered.size).toBeLessThan(new Set(roots).size);
  });

  it("covers every session status and both empty and long histories", () => {
    const fixtures = fc.sample(sessionHistory, { numRuns: 400, seed: SEED });
    expect(new Set(fixtures.map((f) => f.session.status))).toEqual(
      new Set(["active", "idle", "closed"]),
    );
    expect(fixtures.some((f) => f.session.messages.length === 0)).toBe(true);
    expect(fixtures.some((f) => f.session.messages.length > 20)).toBe(true);
    expect(fixtures.some((f) => f.compactions.length > 0)).toBe(true);
  });
});

describe("lifecycleActions", () => {
  it("draws a sequence over a generated Session set sharing one root (R22.2)", () => {
    for (const scenario of fc.sample(lifecycleActions, { numRuns: 200, seed: SEED })) {
      expect(scenario.sessions.length).toBeGreaterThanOrEqual(1);
      expect(scenario.sessions.length).toBeLessThanOrEqual(6);
      expect(new Set(scenario.sessions.map((session) => session.id)).size).toBe(
        scenario.sessions.length,
      );
      expect(new Set(scenario.sessions.map((session) => session.workspace_root)).size).toBe(1);

      expect(scenario.actions.length).toBeGreaterThanOrEqual(1);
      expect(scenario.actions.length).toBeLessThanOrEqual(24);
      for (const action of scenario.actions) {
        if (action.kind !== "create") expect(action.target).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("reaches all six action kinds, and draws interleavings rather than singletons", () => {
    const scenarios = fc.sample(lifecycleActions, { numRuns: 300, seed: SEED });
    const kinds = new Set(scenarios.flatMap((s) => s.actions.map((action) => action.kind)));
    expect(kinds).toEqual(new Set(["create", "rename", "fork", "duplicate", "archive", "delete"]));
    expect(scenarios.some((s) => s.actions.length > 1)).toBe(true);
  });
});

describe("draftAndMode", () => {
  it("pairs a non-empty seeded draft with a selected Conversation_Mode (R22.2)", () => {
    for (const [draft, mode] of fc.sample(draftAndMode, { numRuns: 300, seed: SEED })) {
      expect(draft.trim().length).toBeGreaterThan(0);
      expect(CONVERSATION_MODES).toContain(mode);
      const words = draft.replace(/\?$/, "").split(" ");
      expect(
        RETIRED_ROUTER_TRIGGERS.some(
          (trigger) => words.includes(trigger) || draft.startsWith(trigger),
        ),
      ).toBe(true);
    }
  });

  it("reaches all three of the retired router's decision paths", () => {
    const samples = fc.sample(draftAndMode, { numRuns: 400, seed: SEED });
    const drafts = samples.map(([draft]) => draft);
    // A leading question-or-chat word — the anchored half of the retired pattern.
    expect(
      drafts.some((draft) => RETIRED_ROUTER_QUESTION_TRIGGERS.some((t) => draft.startsWith(t))),
    ).toBe(true);
    // An edit-intent word anywhere.
    expect(
      drafts.some((draft) =>
        RETIRED_ROUTER_EDIT_TRIGGERS.some((t) => draft.split(" ").includes(t)),
      ),
    ).toBe(true);
    // A trailing question mark.
    expect(drafts.some((draft) => draft.endsWith("?"))).toBe(true);
    // And every mode is selectable independently of the draft.
    expect(new Set(samples.map(([, mode]) => mode))).toEqual(new Set(CONVERSATION_MODES));
  });

  it("leaves the Permission_Mode axis out, since Property 76 enumerates it", () => {
    for (const sample of fc.sample(draftAndMode, { numRuns: 20, seed: SEED })) {
      expect(sample).toHaveLength(2);
    }
    // The list is here for that exhaustive product, not for sampling.
    expect(PERMISSION_MODES).toEqual(["ask", "auto", "deny"]);
  });
});
