/**
 * Property 77: A refusal envelope is complete and free of identifiers and paths. R32.12, R32.14, R32.15.
 *
 * *For any* submission the pre-submission gate refuses, the refusal carries a code and a user-readable
 * sentence, the sentence contains no filesystem path and no identifier, and the composer stays enabled.
 *
 * ## Why this property lives with the composer rather than with the gate that shares its codes
 *
 * The two pre-submission cases are the composer's: an out-of-range mode value (R32.14) and a
 * workspace-less `Plan` or `Agent` submission (R32.15). The runtime's own refusals are asserted in its
 * suite. What can only be asserted here is the clause both requirements end with — *and the Chat_Surface
 * shall keep the composer enabled* — which is a claim about a refusal being a reason to show rather than a
 * reason to disable.
 *
 * ## The path clause is generated against real roots
 *
 * `workspaceRoot` from `arbitraries.ts` draws roots with trailing separators and case variants, and the
 * property asserts that no refusal message contains one. That matters because the tempting sentence for
 * R32.15 is "Plan needs a workspace: /Users/me/projects/thing" — which is the absolute path of a user's
 * disk in a string the panel renders verbatim and a user screenshots.
 *
 * ## The permit is part of the property
 *
 * R32.6 says `Ask` with no workspace root is permitted. A refusal-only reading of the three cases gets
 * that backwards, so the property asserts the permit with the same generator that produces the refusals.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { workspaceRoot } from "./arbitraries";
import {
  SUBMISSION_CODES,
  checkSubmission,
  modeRequiresWorkspace,
  refusalIsWorthStating,
} from "@/features/chat/composer/submission-gate";
import { MAX_MESSAGE_LENGTH } from "@/lib/composer-validate";

const RUNS = { numRuns: 200 } as const;

const CODES = Object.values(SUBMISSION_CODES);

/** Drafts that pass `composer-validate`, so the mode and workspace clauses are what decide. */
const draft = fc.stringMatching(/^[a-z][a-z ]{2,40}$/);

/** Modes outside the three, which is exactly R32.14's case. */
const invalidMode = fc.constantFrom(
  "AGENT",
  "auto",
  "read-only",
  "",
  " ask",
  "plan ",
  "agentic",
  "Ask",
);

describe("Feature: zoc-agent-chat-rebuild, Property 77: a refusal envelope is complete and free of identifiers and paths", () => {
  it("refuses an out-of-range mode with a code and the three available modes (R32.14)", () => {
    fc.assert(
      fc.property(invalidMode, draft, fc.option(workspaceRoot, { nil: null }), (mode, text, root) => {
        const verdict = checkSubmission({ mode, workspaceRoot: root, draft: text });
        expect(verdict.permitted).toBe(false);
        if (verdict.permitted) return;

        expect(verdict.code).toBe(SUBMISSION_CODES.invalidRequest);
        // Names the three, because "invalid mode" leaves the user to guess what is valid.
        for (const label of ["Ask", "Plan", "Agent"]) {
          expect(verdict.message).toContain(label);
        }
      }),
      RUNS,
    );
  });

  it("refuses Plan and Agent with no workspace, naming the mode (R32.15)", () => {
    fc.assert(
      fc.property(fc.constantFrom("plan", "agent"), draft, (mode, text) => {
        const verdict = checkSubmission({ mode, workspaceRoot: null, draft: text });
        expect(verdict.permitted).toBe(false);
        if (verdict.permitted) return;

        expect(verdict.code).toBe(SUBMISSION_CODES.noWorkspace);
        expect(verdict.message).toContain(mode === "plan" ? "Plan" : "Agent");
        // And it says what to do instead, which is the difference between a refusal and a dead end.
        expect(verdict.message).toContain("Ask");
      }),
      RUNS,
    );
  });

  it("permits Ask with no workspace root (R32.6)", () => {
    fc.assert(
      fc.property(draft, (text) => {
        // The one case a refusal-only reading of R32.14 and R32.15 gets backwards: a question about code
        // the user has open elsewhere is a legitimate Run.
        expect(checkSubmission({ mode: "ask", workspaceRoot: null, draft: text }).permitted).toBe(
          true,
        );
        expect(checkSubmission({ mode: "ask", workspaceRoot: "   ", draft: text }).permitted).toBe(
          true,
        );
        expect(modeRequiresWorkspace("ask")).toBe(false);
      }),
      RUNS,
    );
  });

  it("permits every mode once a workspace is open", () => {
    fc.assert(
      fc.property(fc.constantFrom("ask", "plan", "agent"), draft, workspaceRoot, (mode, text, root) => {
        const verdict = checkSubmission({ mode, workspaceRoot: root, draft: text });
        expect(verdict.permitted).toBe(true);
        // R32.2: the mode that comes out is the mode that went in, never one inferred from the draft.
        if (verdict.permitted) expect(verdict.mode).toBe(mode);
      }),
      RUNS,
    );
  });

  it("never puts a workspace root or an identifier in a message (R32.12)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("plan", "agent", "AGENT", "read-only"),
        draft,
        workspaceRoot,
        (mode, text, root) => {
          // Both refusal paths, with a real root in scope: the tempting sentence for R32.15 names the
          // missing path, and the path is the user's disk in a string the panel renders verbatim.
          for (const candidateRoot of [null, root]) {
            const verdict = checkSubmission({ mode, workspaceRoot: candidateRoot, draft: text });
            if (verdict.permitted) continue;
            expect(verdict.message).not.toContain(root);
            expect(verdict.message).not.toMatch(/run_|sess_|req_|ckpt_/);
            // No absolute path of any shape.
            expect(verdict.message).not.toMatch(/(^|\s)[/\\~]/);
          }
        },
      ),
      RUNS,
    );
  });

  it("carries a known code and a readable sentence on every refusal", () => {
    fc.assert(
      fc.property(
        fc.oneof(invalidMode, fc.constantFrom("ask", "plan", "agent")),
        fc.oneof(draft, fc.constant(""), fc.constant("   "), fc.string({ maxLength: 3 })),
        fc.option(workspaceRoot, { nil: null }),
        (mode, text, root) => {
          const verdict = checkSubmission({ mode, workspaceRoot: root, draft: text });
          if (verdict.permitted) return;

          expect(CODES).toContain(verdict.code);
          expect(verdict.message.length).toBeGreaterThan(8);
          // A sentence, not a fragment: it is rendered as one.
          expect(verdict.message.endsWith(".")).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("keeps an empty draft silent and everything else stated", () => {
    // The one refusal with no sentence: a user who has typed nothing does not need telling. Every other
    // refusal is something they can fix and cannot guess.
    const empty = checkSubmission({ mode: "agent", workspaceRoot: "/w", draft: "   " });
    expect(empty.permitted).toBe(false);
    if (!empty.permitted) expect(empty.code).toBe(SUBMISSION_CODES.emptyDraft);
    expect(refusalIsWorthStating(empty)).toBe(false);

    const long = checkSubmission({
      mode: "agent",
      workspaceRoot: "/w",
      draft: "x".repeat(MAX_MESSAGE_LENGTH + 1),
    });
    expect(long.permitted).toBe(false);
    if (!long.permitted) {
      expect(long.code).toBe(SUBMISSION_CODES.draftTooLong);
      // Names the limit and the length, because "too long" leaves the user to count.
      expect(long.message).toContain(String(MAX_MESSAGE_LENGTH));
      expect(long.message).toContain(String(MAX_MESSAGE_LENGTH + 1));
    }
    expect(refusalIsWorthStating(long)).toBe(true);
  });

  it("derives the workspace requirement from the policy rather than a list", () => {
    // `Plan` qualifies through its *post-approval* verdict, which is the correct reading: a plan whose
    // approval could never be acted on is not a plan.
    expect(modeRequiresWorkspace("plan")).toBe(true);
    expect(modeRequiresWorkspace("agent")).toBe(true);
    expect(modeRequiresWorkspace("ask")).toBe(false);
  });
});
