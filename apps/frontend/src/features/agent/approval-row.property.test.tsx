/**
 * Property 5: ApprovalRow decision disables both actions and posts the matching
 * verdict.
 *
 * Feature: zoc-agent-ecosystem-merge, Property 5: ApprovalRow decision disables
 * both actions and posts the matching verdict
 *
 * For any approval Event_Row and any selected choice in {approve, reject},
 * selecting that choice posts exactly one decision (via the injectable
 * `onDecision` prop) carrying that verdict and the row's `runId`, disables both
 * the approve and reject actions, and ignores any subsequent selection.
 *
 * Validates: Requirements 5.2, 5.3
 */
import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, fireEvent, waitFor } from "@testing-library/react";
import fc from "fast-check";
import type { AgentEvents } from "@zoc-studio/shared-types";
import {
  ApprovalRow,
  type AgentDecisionRequest,
  type ApprovalDecision,
} from "./rows";

afterEach(() => {
  cleanup();
});

/** Generator for an actionable approval Event_Row (no pre-recorded decision). */
const approvalEventArb: fc.Arbitrary<AgentEvents.ApprovalEvent> = fc.record({
  type: fc.constant<"approval">("approval"),
  seq: fc.nat(),
  runId: fc.string({ minLength: 1, maxLength: 24 }),
  ts: fc
    .date({ min: new Date("2000-01-01T00:00:00.000Z"), max: new Date("2100-01-01T00:00:00.000Z") })
    .map((d) => d.toISOString()),
  prompt: fc.string({ maxLength: 80 }),
});

/** The two verdicts a developer can select. */
const choiceArb: fc.Arbitrary<ApprovalDecision> = fc.constantFrom("approve", "reject");

describe("Feature: zoc-agent-ecosystem-merge, Property 5: ApprovalRow decision disables both actions and posts the matching verdict", () => {
  it("posts exactly one matching decision, disables both actions, and ignores subsequent selections", async () => {
    await fc.assert(
      fc.asyncProperty(approvalEventArb, choiceArb, async (event, choice) => {
        // Each run gets a fresh DOM and a fresh stub transport.
        cleanup();

        const calls: AgentDecisionRequest[] = [];
        const onDecision = (request: AgentDecisionRequest): Promise<void> => {
          calls.push(request);
          return Promise.resolve();
        };

        const { getByRole } = render(
          <ApprovalRow event={event} onDecision={onDecision} />,
        );

        const approveBtn = getByRole("button", { name: /approve/i }) as HTMLButtonElement;
        const rejectBtn = getByRole("button", { name: /reject/i }) as HTMLButtonElement;

        // Before any selection, both actions are enabled.
        expect(approveBtn.disabled).toBe(false);
        expect(rejectBtn.disabled).toBe(false);

        const chosenBtn = choice === "approve" ? approveBtn : rejectBtn;
        const otherBtn = choice === "approve" ? rejectBtn : approveBtn;

        // Select the chosen verdict.
        fireEvent.click(chosenBtn);

        // Both actions are disabled once a decision is recorded/in-flight.
        await waitFor(() => {
          expect(approveBtn.disabled).toBe(true);
          expect(rejectBtn.disabled).toBe(true);
        });

        // Subsequent selections (the other action and the chosen one again) are
        // ignored — no further decisions are posted.
        fireEvent.click(otherBtn);
        fireEvent.click(chosenBtn);

        // Let any pending microtasks/state settle, then assert the invariant.
        await waitFor(() => {
          expect(calls.length).toBe(1);
        });

        // Exactly one decision carrying the row's runId and the chosen verdict.
        expect(calls).toEqual([{ runId: event.runId, decision: choice }]);

        // Both actions remain disabled after a successful post.
        expect(approveBtn.disabled).toBe(true);
        expect(rejectBtn.disabled).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});
