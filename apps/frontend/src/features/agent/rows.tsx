/**
 * rows.tsx — the strict Chat_Renderer: FeedRow → closed ROW_RENDERERS (R9.6, R10).
 *
 * This module is the single renderer for the agent chat surface. It imports
 * `FeedRow` and nothing from the stream/event modules, so "the normalizer is
 * the only path an Agent_Event reaches the renderer" is a compile/lint-time
 * fact (an ESLint `no-restricted-imports` rule + a structural test enforce it).
 *
 * Every `FeedRowKind` has exactly one entry in `ROW_RENDERERS`; a missing
 * renderer is a type error, and an unknown kind at runtime renders nothing and
 * is recorded for diagnostics — never stringified.
 *
 * The legacy event-based decision cards live in `decision-rows.tsx` until the
 * `RunTraceCard` path is fully migrated to `FeedRow[]`.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardList,
  FileDiff,
  RotateCcw,
  ShieldAlert,
  Terminal as TerminalIcon,
  Wrench,
} from "lucide-react";
import { postAgentDecision } from "./gateway-client";
import { cn } from "@/lib/utils";
import { parseUnifiedDiff } from "@/lib/diff-utils";
import { motionClass, transitionClass, useReducedMotion } from "@/lib/reduced-motion";
import { fileStale, type FileProbe } from "./diff-staleness";
import { MarkdownMessage } from "./MarkdownMessage";
import { recordUnrenderableKind } from "./diagnostics";
import { type FeedRow, type FeedRowKind } from "./normalize";
import type { StageReport } from "./stage-report";
import type { RunPhase } from "./run-lifecycle";

/* ══════════════════════════════════════════════════════════════════════════
 * The strict Chat_Renderer: FeedRow → closed ROW_RENDERERS (R10).
 *
 * Every FeedRowKind has exactly one renderer here. Adding a kind without a
 * renderer is a type error; an unknown kind at runtime renders nothing and is
 * recorded for diagnostics. Nothing stringifies an unnormalized payload.
 * ════════════════════════════════════════════════════════════════════════ */

/** Results longer than this render a truncated preview with a reveal control. */
export const TOOL_RESULT_PREVIEW_LINES = 20;

type Row<K extends FeedRowKind> = Extract<FeedRow, { kind: K }>;

/** Actions the rows delegate to (submit a follow-up, retry, request cancel). */
export interface RowActions {
  submitPrompt?: (prompt: string) => void;
  retry?: (operation: string) => void;
  regenerateDiff?: (runId: string, path: string) => void;
  /**
   * Probe a file's current existence + SHA-256 so a diff row can decide
   * staleness against its recorded `baseHash` (R12.7). Returns null when the
   * file can't be probed (no desktop runtime), which is treated as "unknown"
   * rather than stale.
   */
  probeFile?: (path: string) => Promise<FileProbe | null>;
  /**
   * A shared-session viewer reads decision rows (approval, plan, diff) but must
   * not answer them for the host (R15.7). Defaults to false, so a run's own
   * surface keeps its controls.
   */
  readOnly?: boolean;
}

const RowActionsContext = createContext<RowActions>({});

export function RowActionsProvider({
  actions,
  children,
}: {
  actions: RowActions;
  children: React.ReactNode;
}): JSX.Element {
  return <RowActionsContext.Provider value={actions}>{children}</RowActionsContext.Provider>;
}

function useRowActions(): RowActions {
  return useContext(RowActionsContext);
}

function UserMessageRow({ row }: { row: Row<"user-message"> }): JSX.Element {
  return (
    <div className="flex justify-end" data-row-kind="user-message">
      <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-[#1E1E28] px-3 py-2 text-[13px] text-[#EDEDF0]">
        <MarkdownMessage content={row.text} />
      </div>
    </div>
  );
}

function AssistantMessageRow({ row }: { row: Row<"assistant-message"> }): JSX.Element {
  return (
    <div className="flex flex-col gap-1" data-row-kind="assistant-message" data-streaming={row.streaming}>
      <MarkdownMessage content={row.text} />
    </div>
  );
}

function ReasoningPanel({ row }: { row: Row<"reasoning"> }): JSX.Element {
  const [expanded, setExpanded] = useState(!row.collapsed);
  const reduced = useReducedMotion();
  const bodyId = `reasoning-body-${row.id}`;
  return (
    <div
      className={cn("rounded-lg border border-[#26262B] bg-[#0F0F14]", transitionClass("row-expand", reduced))}
      data-row-kind="reasoning"
    >
      <button
        type="button"
        className="zoc-focus-ring flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11.5px] text-[#8A8A93]"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight className={cn("h-3 w-3", expanded && "rotate-90")} />
        Reasoning
      </button>
      {expanded && (
        <div id={bodyId} className="whitespace-pre-wrap px-3 pb-2 font-mono text-[11px] leading-relaxed text-[#A1A1AA]">
          {row.text}
        </div>
      )}
    </div>
  );
}

const TIER_LABEL: Record<string, string> = {
  "local-slm": "Local model",
  edge: "Edge model",
  cloud: "Cloud model",
};

function RunMetadataRow({ row }: { row: Row<"run-metadata"> }): JSX.Element {
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-[11px] text-[#71717A]"
      data-row-kind="run-metadata"
    >
      <span className="rounded border border-[#26262B] px-1.5 py-0.5">
        {TIER_LABEL[row.modelTier] ?? row.modelTier}
      </span>
      <span>{row.contextWindowTokens.toLocaleString()}-token planning budget</span>
      {row.fallbackReason && <span className="text-[var(--zoc-ember)]">Fallback: {row.fallbackReason}</span>}
    </div>
  );
}

const STAGE_LABEL: Record<StageReport["stage"], string> = {
  analyze: "Analyze",
  plan: "Plan",
  edit: "Edit",
  check: "Check",
  review: "Review",
  summary: "Summary",
};

const STAGE_STATE_TONE: Record<StageReport["state"], string> = {
  pending: "text-[#52525B] border-[#26262B]",
  active: "text-[var(--zoc-accent,#a78bfa)] border-[var(--zoc-accent,#a78bfa)]/40",
  succeeded: "text-[var(--zoc-success)] border-[var(--zoc-success)]/40",
  failed: "text-[var(--zoc-error)] border-[var(--zoc-error)]/40",
  skipped: "text-[#52525B] border-[#26262B] line-through",
};

function StageStrip({ row }: { row: Row<"stage"> }): JSX.Element {
  const failed = row.stages.find((s) => s.state === "failed");
  return (
    <div className="flex flex-col gap-1" data-row-kind="stage">
      <div className="flex flex-wrap items-center gap-1.5">
        {row.stages.map((s) => (
          <span
            key={s.stage}
            className={cn(
              "rounded border px-1.5 py-0.5 text-[10.5px] font-medium",
              STAGE_STATE_TONE[s.state],
            )}
            data-stage={s.stage}
            data-state={s.state}
          >
            {STAGE_LABEL[s.stage]}
          </span>
        ))}
      </div>
      {failed?.reason && (
        <p className="text-[11px] text-[var(--zoc-error)]">
          {STAGE_LABEL[failed.stage]} failed: {failed.reason}
        </p>
      )}
    </div>
  );
}

const TOOL_STATUS_TONE: Record<string, string> = {
  running: "text-[var(--zoc-accent,#a78bfa)]",
  succeeded: "text-[var(--zoc-success)]",
  failed: "text-[var(--zoc-error)]",
};

function ToolResult({ result }: { result: string }): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const lines = result.split("\n");
  const truncated = lines.length > TOOL_RESULT_PREVIEW_LINES;
  const shown = revealed || !truncated ? result : lines.slice(0, TOOL_RESULT_PREVIEW_LINES).join("\n");
  return (
    <div>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-[#1E1E23] bg-[#0A0A0E] p-2 font-mono text-[10.5px] leading-relaxed text-[#A1A1AA]">
        {shown}
      </pre>
      {truncated && (
        <button
          type="button"
          className="zoc-focus-ring mt-1 text-[10.5px] text-[#60a5fa] hover:underline"
          onClick={() => setRevealed((v) => !v)}
        >
          {revealed ? "Show less" : `Show all ${lines.length} lines`}
        </button>
      )}
    </div>
  );
}

function ToolCallCardRow({ row }: { row: Row<"tool-call"> }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const bodyId = `tool-body-${row.id}`;
  const canExpand = row.result != null || row.failure != null;
  return (
    <div className="rounded-lg border border-[#26262B] bg-[#0F0F14] p-2" data-row-kind="tool-call">
      <button
        type="button"
        className="zoc-focus-ring flex w-full items-center gap-2 text-left"
        aria-expanded={canExpand ? expanded : undefined}
        aria-controls={canExpand ? bodyId : undefined}
        onClick={() => canExpand && setExpanded((v) => !v)}
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-[#8A8A93]" />
        <span className="font-mono text-[11.5px] text-[#D4D4D8]">{row.tool}</span>
        {row.target && (
          <span className="truncate font-mono text-[11px] text-[#71717A]">{row.target}</span>
        )}
        <span className={cn("ml-auto text-[11px] font-medium", TOOL_STATUS_TONE[row.status])}>
          {row.status}
        </span>
      </button>
      {expanded && (
        <div id={bodyId}>
          {row.failure && <p className="mt-1 text-[11px] text-[var(--zoc-error)]">{row.failure}</p>}
          {row.result != null && <ToolResult result={row.result} />}
        </div>
      )}
    </div>
  );
}

function ToolCallGroup({ row }: { row: Row<"tool-group"> }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const bodyId = `tool-group-body-${row.id}`;
  return (
    <div className="rounded-lg border border-[#26262B] bg-[#0F0F14] p-2" data-row-kind="tool-group">
      <button
        type="button"
        className="zoc-focus-ring flex w-full items-center gap-2 text-left"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
      >
        <ChevronRight className={cn("h-3 w-3", expanded && "rotate-90")} />
        <Wrench className="h-3.5 w-3.5 text-[#8A8A93]" />
        <span className="font-mono text-[11.5px] text-[#D4D4D8]">{row.tool}</span>
        <span className="ml-auto rounded-full border border-[#26262B] px-1.5 text-[10.5px] text-[#8A8A93]">
          {row.count} calls
        </span>
      </button>
      {expanded && (
        <div id={bodyId} className="mt-1.5 flex flex-col gap-1.5">
          {row.members.map((member) => (
            <ToolCallCardRow key={member.id} row={member} />
          ))}
        </div>
      )}
    </div>
  );
}

function DiffFileEntry({
  file,
  stale,
  runId,
}: {
  file: Row<"diff">["files"][number];
  stale: boolean;
  runId: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const actions = useRowActions();
  const parsed = useMemo(() => parseUnifiedDiff(file.diff), [file.diff]);
  const bodyId = `diff-body-${runId}-${file.path}`;
  return (
    <div className="rounded-lg border border-[#26262B] bg-[#0F0F14]" data-diff-file={file.path} data-stale={stale}>
      <button
        type="button"
        className="zoc-focus-ring flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setExpanded((v) => !v)}
      >
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-[#8A8A93]" />
        <span className="truncate font-mono text-[11.5px] text-[#D4D4D8]">{file.path}</span>
        <span className="ml-auto text-[11px] text-[var(--zoc-success)]">+{file.adds}</span>
        <span className="text-[11px] text-[var(--zoc-error)]">−{file.dels}</span>
      </button>
      {expanded && (
        <div id={bodyId} className="border-t border-[#1E1E23] p-2">
          {parsed.hunks.flatMap((hunk, hi) =>
            hunk.lines.map((line, li) => (
              <div
                key={`${hi}-${li}`}
                className={cn(
                  "flex gap-2 font-mono text-[10.5px] leading-relaxed",
                  line.kind === "add" && "bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]",
                  line.kind === "del" && "bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]",
                  line.kind === "ctx" && "text-[#8A8A93]",
                )}
              >
                {/* Text label in addition to colour (R12.2). */}
                <span className="w-14 shrink-0 select-none text-[9.5px] uppercase opacity-70">
                  {line.kind === "add" ? "added" : line.kind === "del" ? "removed" : ""}
                </span>
                <span className="whitespace-pre-wrap">{line.text}</span>
              </div>
            )),
          )}
        </div>
      )}
      {stale && (
        <div className="flex items-center gap-2 border-t border-[#1E1E23] px-2.5 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--zoc-ember)]" />
          <span className="text-[11px] text-[var(--zoc-ember)]">
            The file changed since this was proposed.
          </span>
          <button
            type="button"
            className="zoc-focus-ring ml-auto rounded border border-[#26262B] px-2 py-0.5 text-[11px] text-[#D4D4D8]"
            onClick={() => actions.regenerateDiff?.(runId, file.path)}
          >
            <RotateCcw className="mr-1 inline h-3 w-3" />
            Regenerate
          </button>
        </div>
      )}
    </div>
  );
}

function DiffCardRow({ row }: { row: Row<"diff"> }): JSX.Element {
  const actions = useRowActions();
  // The accept/reject axis. "stale" is no longer a decision — it's computed
  // live below (R12.7) — so a normalizer-provided "stale" collapses to pending.
  type DiffDecision = "pending" | "applying" | "discarding" | "applied" | "rejected";
  const [decision, setDecision] = useState<DiffDecision>(
    row.decision === "applied" || row.decision === "rejected" ? row.decision : "pending",
  );
  const [staleFiles, setStaleFiles] = useState<ReadonlySet<string>>(new Set());
  const settled = useRef(row.decision === "applied" || row.decision === "rejected");

  // Live staleness: probe each file's current SHA-256/existence and compare to
  // the recorded baseHash (R12.7). Files with no recorded baseHash are skipped.
  useEffect(() => {
    const probe = actions.probeFile;
    if (!probe) return;
    let cancelled = false;
    void (async () => {
      const stale = new Set<string>();
      for (const file of row.files) {
        if (!file.baseHash) continue;
        const result = await probe(file.path);
        if (fileStale(file.baseHash, result)) stale.add(file.path);
      }
      if (!cancelled) setStaleFiles(stale);
    })();
    return () => {
      cancelled = true;
    };
  }, [actions, row.files]);

  async function decide(choice: "apply" | "discard"): Promise<void> {
    if (settled.current) return;
    settled.current = true;
    // No optimistic terminal state: show the in-flight state, and only mark
    // applied/rejected AFTER the Gateway acknowledges the decision (R12.5).
    setDecision(choice === "apply" ? "applying" : "discarding");
    try {
      await postAgentDecision({
        runId: row.runId,
        decision: choice,
        // Accept applies every selected file — the whole diff card here (R12.4).
        acceptedPaths: choice === "apply" ? row.files.map((f) => f.path) : [],
      });
      setDecision(choice === "apply" ? "applied" : "rejected");
    } catch {
      settled.current = false;
      setDecision("pending");
    }
  }

  const inFlight = decision === "applying" || decision === "discarding";
  return (
    <div className="flex flex-col gap-1.5" data-row-kind="diff">
      {row.files.map((file) => (
        <DiffFileEntry
          key={file.path}
          file={file}
          stale={staleFiles.has(file.path)}
          runId={row.runId}
        />
      ))}
      {decision === "pending" && actions.readOnly && (
        <span className="text-[11.5px] text-[#71717A]">
          Waiting for the host to review these changes.
        </span>
      )}
      {decision === "pending" && !actions.readOnly && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="zoc-focus-ring rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--zoc-success)]"
            onClick={() => void decide("apply")}
          >
            <Check className="mr-1 inline h-3.5 w-3.5" />
            Accept
          </button>
          <button
            type="button"
            className="zoc-focus-ring rounded-lg border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--zoc-error)]"
            onClick={() => void decide("discard")}
          >
            Reject
          </button>
        </div>
      )}
      {inFlight && (
        <span className="text-[11px] text-[#71717A]">
          {decision === "applying" ? "Applying…" : "Discarding…"}
        </span>
      )}
      {decision === "applied" && <span className="text-[11px] text-[var(--zoc-success)]">Applied</span>}
      {decision === "rejected" && <span className="text-[11px] text-[var(--zoc-error)]">Rejected</span>}
    </div>
  );
}

const COMMAND_STATUS_TONE: Record<string, string> = {
  fail: "text-[var(--zoc-error)]",
  failed: "text-[var(--zoc-error)]",
  pass: "text-[var(--zoc-success)]",
  succeeded: "text-[var(--zoc-success)]",
};

function CommandRow({ row }: { row: Row<"command"> }): JSX.Element {
  return (
    <div className="rounded-lg border border-[#26262B] bg-[#0F0F14] p-2" data-row-kind="command">
      <div className="flex items-center gap-2">
        <TerminalIcon className="h-3.5 w-3.5 text-[#8A8A93]" />
        <span className="truncate font-mono text-[11.5px] text-[#D4D4D8]">{row.command}</span>
        <span className={cn("ml-auto text-[11px]", COMMAND_STATUS_TONE[row.status] ?? "text-[#8A8A93]")}>
          {row.status}
          {row.exitCode != null && ` (${row.exitCode})`}
        </span>
      </div>
      {row.outputTail && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-[#1E1E23] bg-[#0A0A0E] p-2 font-mono text-[10.5px] text-[#A1A1AA]">
          {row.outputTail}
        </pre>
      )}
    </div>
  );
}

function useFocusOnPending(decisionSettled: boolean): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!decisionSettled) {
      const control = ref.current?.querySelector<HTMLButtonElement>("button");
      control?.focus();
    }
  }, [decisionSettled]);
  return ref;
}

function ApprovalFeedRow({ row }: { row: Row<"approval"> }): JSX.Element {
  const actions = useRowActions();
  const [decision, setDecision] = useState(row.decision);
  const settled = useRef(row.decision != null);
  const groupRef = useFocusOnPending(settled.current);
  async function decide(choice: "approve" | "reject"): Promise<void> {
    if (settled.current) return;
    settled.current = true;
    setDecision(choice);
    try {
      await postAgentDecision({ runId: row.runId, decision: choice });
    } catch {
      settled.current = false;
      setDecision(null);
    }
  }
  return (
    <div
      className="rounded-xl border border-[var(--zoc-ember)]/30 bg-[rgba(251,146,60,0.06)] p-3"
      data-row-kind="approval"
      role="group"
      aria-label="Approval required"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-[var(--zoc-ember)]">
        <ShieldAlert className="h-3.5 w-3.5" /> Approval required
      </div>
      <p className="mb-1 text-[12.5px] text-[#C8C8CE]">{row.prompt}</p>
      <p className="mb-2 text-[11px] text-[#8A8A93]">
        Operation: <span className="font-mono text-[#A1A1AA]">{row.tool ?? row.operation}</span>
        {row.target && (
          <>
            {" · "}
            <span className="font-mono text-[#A1A1AA]">{row.target}</span>
          </>
        )}
      </p>
      <div ref={groupRef} className="flex items-center gap-2">
        {actions.readOnly && !decision ? (
          <span className="text-[11.5px] text-[#71717A]">
            Waiting for the host to approve or reject.
          </span>
        ) : decision ? (
          <span className={cn("text-[12px] font-medium", decision === "approve" ? "text-[var(--zoc-success)]" : "text-[var(--zoc-error)]")}>
            {decision === "approve" ? "Approved" : "Rejected"}
          </span>
        ) : (
          <>
            <button
              type="button"
              className="zoc-focus-ring rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--zoc-success)]"
              onClick={() => void decide("approve")}
            >
              Approve
            </button>
            <button
              type="button"
              className="zoc-focus-ring rounded-lg border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--zoc-error)]"
              onClick={() => void decide("reject")}
            >
              Reject
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function PlanReadyFeedRow({ row }: { row: Row<"plan-ready"> }): JSX.Element {
  const actions = useRowActions();
  const [decision, setDecision] = useState<"approve" | "reject" | null>(null);
  const settled = useRef(false);
  const groupRef = useFocusOnPending(settled.current);
  const fileCount = new Set(row.steps.map((s) => s.file)).size;
  async function decide(choice: "approve" | "reject"): Promise<void> {
    if (settled.current) return;
    settled.current = true;
    setDecision(choice);
    try {
      await postAgentDecision({ runId: row.runId, decision: choice });
    } catch {
      settled.current = false;
      setDecision(null);
    }
  }
  return (
    <div
      className="rounded-xl border border-[#fbbf24]/30 bg-[rgba(251,191,36,0.05)] p-3"
      data-row-kind="plan-ready"
      role="group"
      aria-label="Plan ready"
    >
      <div className="mb-1 flex items-center gap-1.5 text-[12px] font-semibold text-[#fbbf24]">
        <ClipboardList className="h-3.5 w-3.5" /> Plan ready
      </div>
      <p className="mb-2 text-[12.5px] text-[#C8C8CE]">
        {row.steps.length} step{row.steps.length === 1 ? "" : "s"} across {fileCount} file
        {fileCount === 1 ? "" : "s"}.
      </p>
      <ul className="mb-2 space-y-1">
        {row.steps.map((step, i) => (
          <li key={`${step.file}-${i}`} className="font-mono text-[11px] text-[#D4D4D8]">
            <span className="uppercase text-[#8A8A93]">{step.action}</span> {step.file}
          </li>
        ))}
      </ul>
      {row.verificationCommand && (
        <p className="mb-2 font-mono text-[10.5px] text-[#71717A]">Verify: {row.verificationCommand}</p>
      )}
      <div ref={groupRef} className="flex items-center gap-2">
        {actions.readOnly && !decision ? (
          <span className="text-[11.5px] text-[#71717A]">
            Waiting for the host to approve or cancel this plan.
          </span>
        ) : decision ? (
          <span className={cn("text-[12px] font-medium", decision === "approve" ? "text-[var(--zoc-success)]" : "text-[var(--zoc-error)]")}>
            {decision === "approve" ? "Applying…" : "Cancelled"}
          </span>
        ) : (
          <>
            <button
              type="button"
              className="zoc-focus-ring rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--zoc-success)]"
              onClick={() => void decide("approve")}
            >
              Apply plan
            </button>
            <button
              type="button"
              className="zoc-focus-ring rounded-lg border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-1 text-[12px] font-semibold text-[var(--zoc-error)]"
              onClick={() => void decide("reject")}
            >
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const OUTCOME_LABEL: Partial<Record<RunPhase, string>> = {
  done: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Interrupted",
};

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function RunSummaryRow({ row }: { row: Row<"run-summary"> }): JSX.Element {
  const showAgentReason = row.mode === "agent" && row.filesChanged === 0;
  const showNonAgentReason = row.mode !== "agent" && row.reason;
  return (
    <div
      className="flex flex-col gap-1 rounded-lg border border-[#26262B] bg-[#0F0F14] p-2.5"
      data-row-kind="run-summary"
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold text-[#EDEDF0]">{OUTCOME_LABEL[row.outcome] ?? row.outcome}</span>
        <span className="text-[#71717A]">· {formatDuration(row.elapsedMs)}</span>
        {row.mode === "agent" && (
          <span className="text-[#71717A]">
            · {row.filesChanged} file{row.filesChanged === 1 ? "" : "s"} changed
          </span>
        )}
        {row.mode === "plan" && (
          <span className="text-[#71717A]">· No changes applied</span>
        )}
      </div>
      {showAgentReason && (
        <p className="text-[11px] text-[#8A8A93]">
          No files were changed{row.reason ? `: ${row.reason}` : "."}
        </p>
      )}
      {showNonAgentReason && (
        <p className="text-[11px] text-[#8A8A93]">{row.reason}</p>
      )}
    </div>
  );
}

function ErrorRow({ row }: { row: Row<"error"> }): JSX.Element {
  const actions = useRowActions();
  return (
    <div
      className="rounded-lg border border-[var(--zoc-error)]/30 bg-[var(--zoc-error)]/5 p-2.5"
      data-row-kind="error"
      role="alert"
    >
      <div className="flex items-center gap-2 text-[12px] font-semibold text-[var(--zoc-error)]">
        <AlertTriangle className="h-3.5 w-3.5" />
        {row.operation} failed
        <span className="font-mono text-[10.5px] font-normal text-[#8A8A93]">({row.code})</span>
      </div>
      <p className="mt-1 text-[12px] text-[#C8C8CE]">{row.message}</p>
      {row.retryable && (
        <button
          type="button"
          className="zoc-focus-ring mt-1.5 rounded border border-[#26262B] px-2 py-0.5 text-[11px] text-[#D4D4D8]"
          onClick={() => actions.retry?.(row.operation)}
        >
          <RotateCcw className="mr-1 inline h-3 w-3" />
          Retry
        </button>
      )}
    </div>
  );
}

function FollowUpChips({ row }: { row: Row<"follow-ups"> }): JSX.Element | null {
  const actions = useRowActions();
  if (row.chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" data-row-kind="follow-ups">
      {row.chips.map((chip) => (
        <button
          key={chip.id}
          type="button"
          className="zoc-focus-ring rounded-full border border-[#26262B] bg-[#141419] px-3 py-1 text-[11.5px] text-[#D4D4D8] hover:border-[var(--zoc-accent,#a78bfa)]/40"
          onClick={() => actions.submitPrompt?.(chip.prompt)}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The exhaustive registry. A missing renderer for a FeedRowKind is a type error.
 */
export const ROW_RENDERERS: {
  [K in FeedRowKind]: (row: Extract<FeedRow, { kind: K }>) => JSX.Element | null;
} = {
  "user-message": (row) => <UserMessageRow row={row} />,
  "assistant-message": (row) => <AssistantMessageRow row={row} />,
  reasoning: (row) => <ReasoningPanel row={row} />,
  "run-metadata": (row) => <RunMetadataRow row={row} />,
  stage: (row) => <StageStrip row={row} />,
  "tool-call": (row) => <ToolCallCardRow row={row} />,
  "tool-group": (row) => <ToolCallGroup row={row} />,
  diff: (row) => <DiffCardRow row={row} />,
  command: (row) => <CommandRow row={row} />,
  approval: (row) => <ApprovalFeedRow row={row} />,
  "plan-ready": (row) => <PlanReadyFeedRow row={row} />,
  "run-summary": (row) => <RunSummaryRow row={row} />,
  error: (row) => <ErrorRow row={row} />,
  "follow-ups": (row) => <FollowUpChips row={row} />,
};

/**
 * Render one feed row. An unknown kind renders nothing and is recorded for
 * diagnostics (R10.2) — never stringified.
 */
export function renderRow(row: FeedRow): JSX.Element | null {
  const renderer = ROW_RENDERERS[row.kind as FeedRowKind] as
    | ((r: FeedRow) => JSX.Element | null)
    | undefined;
  if (!renderer) {
    recordUnrenderableKind(row.kind);
    return null;
  }
  return renderer(row);
}

/** R18.2 — the chat surface shows a streaming indicator iff a row is streaming. */
export function shouldShowStreamingIndicator(rows: readonly FeedRow[]): boolean {
  return rows.some((r) => r.kind === "assistant-message" && r.streaming);
}

/**
 * The single streaming indicator, rendered once by the feed container (never
 * per row). Returns null when nothing is streaming, so exactly one or zero
 * indicators exist for the whole surface (R18.2).
 */
export function StreamingIndicator({ rows }: { rows: readonly FeedRow[] }): JSX.Element | null {
  const reduced = useReducedMotion();
  if (!shouldShowStreamingIndicator(rows)) return null;
  const dot = motionClass("typing-dot", reduced);
  return (
    <div
      data-testid="streaming-indicator"
      aria-hidden="true"
      className="flex items-center gap-1 py-1 text-[var(--zoc-accent,#a78bfa)]"
    >
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current", dot)} />
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current [animation-delay:150ms]", dot)} />
      <span className={cn("h-1.5 w-1.5 rounded-full bg-current [animation-delay:300ms]", dot)} />
    </div>
  );
}
