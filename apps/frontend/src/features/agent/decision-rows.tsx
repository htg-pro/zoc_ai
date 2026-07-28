/**
 * decision-rows.tsx — the legacy event-based decision cards.
 *
 * These consume `AgentEvents.*` frames directly and are retained for the
 * `RunTraceCard` render path until it is fully migrated to `FeedRow[]`. They
 * deliberately live OUTSIDE `rows.tsx` so the strict renderer (`rows.tsx`) can
 * satisfy the "renderer imports no stream/event module" seam rule (R9.6). New
 * code renders approvals and plans through the closed `ROW_RENDERERS`.
 */
import { useRef, useState } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";
import { CheckCircle2, ClipboardList, ShieldAlert, XCircle } from "lucide-react";
import { postAgentDecision } from "./gateway-client";
import { cn } from "@/lib/utils";

export interface RowProps<E> {
  event: E;
}

/* ── Approval ──────────────────────────────────────────────────────────── */

export type ApprovalDecision = "approve" | "reject";
export interface AgentDecisionRequest {
  runId: string;
  decision: ApprovalDecision;
}
export interface ApprovalRowProps extends RowProps<AgentEvents.ApprovalEvent> {
  onDecision?: (request: AgentDecisionRequest) => void | Promise<void>;
  /** A shared-session viewer reads the request but cannot answer it. */
  readOnly?: boolean;
}

export function ApprovalRow({
  event,
  onDecision = postAgentDecision,
  readOnly = false,
}: ApprovalRowProps): JSX.Element {
  const [decision, setDecision] = useState<ApprovalDecision | undefined>(
    event.decision ?? undefined,
  );
  const settledRef = useRef<boolean>(event.decision != null);
  const decided = decision !== undefined;

  async function handleDecision(choice: ApprovalDecision): Promise<void> {
    if (settledRef.current) return;
    settledRef.current = true;
    setDecision(choice);
    try {
      await onDecision({ runId: event.runId, decision: choice });
    } catch {
      settledRef.current = false;
      setDecision(undefined);
    }
  }

  return (
    <div className="flex gap-2.5 animate-fade-row" data-event-type="approval">
      <div className="flex flex-col items-center shrink-0">
        <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--zoc-ember)]/40 bg-[rgba(251,146,60,0.12)] text-[var(--zoc-ember)]">
          <ShieldAlert className="h-3 w-3" />
        </div>
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-[var(--zoc-ember)]/30 bg-[rgba(251,146,60,0.06)] p-3">
        <div className="text-[12px] font-semibold text-[var(--zoc-ember)] mb-1">Approval required</div>
        <p className="text-[12.5px] text-[#C8C8CE] leading-relaxed mb-3">{event.prompt}</p>
        <div className="flex items-center gap-2">
          {readOnly && !decided ? (
            <span className="text-[11.5px] text-[#71717A]">
              Waiting for the host to approve or reject.
            </span>
          ) : decided ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium border",
                decision === "approve"
                  ? "border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]"
                  : "border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]",
              )}
            >
              {decision === "approve" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {decision === "approve" ? "Approved" : "Rejected"}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--zoc-success)] transition-colors hover:bg-[var(--zoc-success)]/20 disabled:opacity-50"
                disabled={decided}
                onClick={() => void handleDecision("approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--zoc-error)] transition-colors hover:bg-[var(--zoc-error)]/20 disabled:opacity-50"
                disabled={decided}
                onClick={() => void handleDecision("reject")}
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Plan ready (Plan mode, §12.2) ─────────────────────────────────────── */

const ACTION_TONE: Record<string, string> = {
  create: "border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]",
  modify: "border-[var(--zoc-ember)]/40 bg-[rgba(251,146,60,0.12)] text-[var(--zoc-ember)]",
  delete: "border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]",
  rename: "border-[#60a5fa]/40 bg-[#60a5fa]/10 text-[#60a5fa]",
};

export interface PlanReadyRowProps extends RowProps<AgentEvents.PlanReadyEvent> {
  onDecision?: (request: AgentDecisionRequest) => void | Promise<void>;
  /**
   * A shared-session viewer watches the host's run and must not decide for them.
   * The plan stays fully readable; only the decision controls are withheld.
   */
  readOnly?: boolean;
}

/**
 * The Plan-mode review card (§12.2).
 */
export function PlanReadyRow({
  event,
  onDecision = postAgentDecision,
  readOnly = false,
}: PlanReadyRowProps): JSX.Element {
  const [excluded, setExcluded] = useState<Set<number>>(() => new Set());
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [decision, setDecision] = useState<ApprovalDecision | undefined>(undefined);
  const settledRef = useRef(false);

  const included = event.steps.filter((_, index) => !excluded.has(index));
  const includedFiles = Array.from(new Set(included.map((step) => step.file)));

  const toggleStep = (index: number) => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleDiff = (index: number) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  async function decide(choice: ApprovalDecision): Promise<void> {
    if (settledRef.current) return;
    settledRef.current = true;
    setDecision(choice);
    try {
      await onDecision({
        runId: event.runId,
        decision: choice,
        ...(choice === "approve" && excluded.size > 0
          ? { acceptedPaths: includedFiles }
          : {}),
      } as AgentDecisionRequest & { acceptedPaths?: string[] });
    } catch {
      settledRef.current = false;
      setDecision(undefined);
    }
  }

  const decided = decision !== undefined;

  return (
    <div className="flex gap-2.5 animate-fade-row" data-event-type="plan-ready">
      <div className="flex shrink-0 flex-col items-center">
        <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border border-[#fbbf24]/40 bg-[rgba(251,191,36,0.12)] text-[#fbbf24]">
          <ClipboardList className="h-3 w-3" />
        </div>
      </div>
      <div className="min-w-0 flex-1 rounded-xl border border-[#fbbf24]/30 bg-[rgba(251,191,36,0.05)] p-3">
        <div className="mb-1 text-[12px] font-semibold text-[#fbbf24]">Plan ready</div>
        <p className="mb-2 text-[12.5px] leading-relaxed text-[#C8C8CE]">
          Ready to apply {included.length} change{included.length === 1 ? "" : "s"} to{" "}
          {includedFiles.length} file{includedFiles.length === 1 ? "" : "s"}. Approve to
          execute, reject to cancel.
        </p>

        <ul className="mb-3 space-y-1.5" data-testid="plan-ready-steps">
          {event.steps.map((step, index) => {
            const off = excluded.has(index);
            const open = expanded.has(index);
            return (
              <li
                key={`${step.file}-${index}`}
                className={cn(
                  "rounded-lg border border-[#26262B] bg-[#0F0F14] p-2",
                  off && "opacity-50",
                )}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={!off}
                    disabled={decided || readOnly}
                    onChange={() => toggleStep(index)}
                    aria-label={`Include ${step.file}`}
                    className="mt-0.5 h-3 w-3 shrink-0 accent-[#fbbf24]"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "rounded border px-1 py-0.5 text-[9.5px] font-semibold uppercase",
                          ACTION_TONE[step.action] ?? ACTION_TONE.modify,
                        )}
                      >
                        {step.action}
                      </span>
                      <span className="truncate font-mono text-[11.5px] text-[#D4D4D8]">
                        {step.file}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11.5px] leading-snug text-[#8A8A93]">
                      {step.rationale}
                    </p>
                    {step.diff && (
                      <button
                        type="button"
                        onClick={() => toggleDiff(index)}
                        aria-expanded={open}
                        className="mt-1 text-[10.5px] text-[#60a5fa] hover:underline"
                      >
                        {open ? "Hide diff" : "Show diff"}
                      </button>
                    )}
                  </div>
                </div>
                {open && step.diff && (
                  <pre className="mt-1.5 max-h-56 overflow-auto rounded border border-[#1E1E23] bg-[#0A0A0E] p-2 font-mono text-[10.5px] leading-relaxed text-[#A1A1AA]">
                    {step.diff}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>

        {event.verificationCommand && (
          <p className="mb-2 font-mono text-[10.5px] text-[#71717A]">
            Then verify with: {event.verificationCommand}
          </p>
        )}

        <div className="flex items-center gap-2">
          {readOnly ? (
            <span className="text-[11.5px] text-[#71717A]">
              Waiting for the host to approve or cancel this plan.
            </span>
          ) : decided ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium",
                decision === "approve"
                  ? "border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]"
                  : "border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]",
              )}
            >
              {decision === "approve" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {decision === "approve" ? "Applying…" : "Cancelled"}
            </span>
          ) : (
            <>
              <button
                type="button"
                disabled={included.length === 0}
                onClick={() => void decide("approve")}
                className="rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--zoc-success)] transition-colors hover:bg-[var(--zoc-success)]/20 disabled:opacity-40"
              >
                Apply all ({included.length} step{included.length === 1 ? "" : "s"})
              </button>
              <button
                type="button"
                onClick={() => void decide("reject")}
                className="rounded-lg border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--zoc-error)] transition-colors hover:bg-[var(--zoc-error)]/20"
              >
                Cancel
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
