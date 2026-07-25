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

        const { getByRole, getByText, queryByRole } = render(
          <ApprovalRow event={event} onDecision={onDecision} />,
        );

        const approveBtn = getByRole("button", { name: /approve/i }) as HTMLButtonElement;
        const rejectBtn = getByRole("button", { name: /reject/i }) as HTMLButtonElement;

        // Before any selection, both actions are enabled.
        expect(approveBtn.disabled).toBe(false);
        expect(rejectBtn.disabled).toBe(false);

        const chosenBtn = choice === "approve" ? approveBtn : rejectBtn;
        const otherBtn = choice === "approve" ? rejectBtn : approveBtn;

        // Select the chosen verdict, then attempt rapid duplicate selections
        // through the previously captured controls. The settled ref must make
        // every later handler invocation a no-op.
        fireEvent.click(chosenBtn);
        fireEvent.click(otherBtn);
        fireEvent.click(chosenBtn);

        await waitFor(() => {
          expect(calls).toEqual([{ runId: event.runId, decision: choice }]);
          expect(getByText(choice === "approve" ? "Approved" : "Rejected")).toBeInTheDocument();
        });

        // Settled rows replace both actions with the immutable result badge.
        expect(queryByRole("button", { name: /approve/i })).toBeNull();
        expect(queryByRole("button", { name: /reject/i })).toBeNull();
      }),
      { numRuns: 100 },
    );
  });
});
