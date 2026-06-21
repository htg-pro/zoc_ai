import { useEffect, useMemo, useState } from "react";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  Circle,
  ClipboardCheck,
  FileDiff,
  FileText,
  Loader2,
  RotateCcw,
  Terminal,
  TestTube2,
  XCircle,
} from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { parseUnifiedDiff } from "@/lib/diff-utils";
import { useApp } from "@/lib/store";
import { postAgentDecision } from "./gateway-client";
import { cn } from "@/lib/utils";
import type {
  RunTrace,
  TraceActivity,
  TracePlanItem,
  TraceReview,
  TraceReviewFile,
  TraceTestResults,
} from "./agent-trace";

type SideBySideLine = {
  id: string;
  kind: "ctx" | "add" | "del" | "replace" | "header";
  oldNum?: number;
  newNum?: number;
  oldText: string;
  newText: string;
};

interface RunTraceCardProps {
  trace: RunTrace;
}

const STAGES = [
  { id: "analyze", label: "Analyze" },
  { id: "plan",    label: "Plan" },
  { id: "apply",   label: "Edit" },
  { id: "validate",label: "Check" },
  { id: "review",  label: "Review" },
  { id: "summary", label: "Summary" },
];

export function RunTraceCard({ trace }: RunTraceCardProps): JSX.Element {
  const isDone   = trace.status === "done";
  const isFailed = trace.status === "failed";
  const isPaused = trace.status === "paused";
  const isReview = trace.status === "awaiting_review";
  const isActive = !isDone && !isFailed && !isPaused && !isReview;
  const checkpointCommit = useApp((s) => s.agentRunCheckpoints[trace.runId]);
  const restoreAgentRunCheckpoint = useApp((s) => s.restoreAgentRunCheckpoint);
  const [restorePending, setRestorePending] = useState(false);

  const accentColor = isDone
    ? "var(--zoc-success)"
    : isFailed
      ? "var(--zoc-error)"
      : isReview
        ? "var(--zoc-ember)"
        : "var(--zoc-agent)";

  return (
    <section
      className="relative overflow-hidden rounded-xl border border-[#1E1E23] bg-[#0F0F14] shadow-sm animate-fade-row"
      data-testid="run-trace-card"
      data-run-status={trace.status}
    >
      {/* left accent bar */}
      <div
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-xl"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />

      {/* Header */}
      <div className="flex min-w-0 items-center gap-3 px-4 py-2.5 pl-5 border-b border-[#1E1E23]">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {isActive ? (
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ backgroundColor: accentColor }} />
              <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: accentColor }} />
            </span>
          ) : (
            <span className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
          )}
          <div className="min-w-0">
            <span className="text-[13px] font-semibold text-[#FAFAFA]">Agent run</span>
            <span className="ml-2 text-[11px] text-[#71717A]">{statusLabel(trace)}</span>
          </div>
        </div>
        {checkpointCommit && (
          <button
            type="button"
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-[#26262B] bg-[#15151A] px-2.5 text-[11px] font-medium text-[#C8C8CE] transition-colors hover:bg-[#1E1E23] disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="restore-checkpoint-button"
            disabled={restorePending}
            title={`Restore checkpoint ${checkpointCommit.slice(0, 8)}`}
            onClick={() => {
              setRestorePending(true);
              void restoreAgentRunCheckpoint(trace.runId).finally(() => setRestorePending(false));
            }}
          >
            {restorePending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
            )}
            Restore checkpoint
          </button>
        )}
        {(trace.checkpointId || checkpointCommit) && (
          <span className="shrink-0 rounded-md border border-[#26262B] bg-[#15151A] px-1.5 py-0.5 font-mono text-[10px] text-[#71717A]">
            checkpoint
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 px-4 py-3 pl-5">
        <StageStepper activeStage={trace.stage} status={trace.status} />
        {trace.planItems.length > 0 && <TodoSection items={trace.planItems} />}
        {trace.activities.length > 0 && <ActivitySection activities={trace.activities} />}
        {trace.testResults && <TestResultsPanel result={trace.testResults} />}
        {trace.review && <ReviewChangesRow runId={trace.runId} review={trace.review} />}
        {trace.error && (
          <div className="rounded-lg border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/8 px-3 py-2 text-[12px] text-[var(--zoc-error)]">
            {trace.error}
          </div>
        )}
      </div>
    </section>
  );
}

function TestResultsPanel({ result }: { result: TraceTestResults }): JSX.Element {
  const passed = result.status === "pass";
  const duration = result.durationMs < 1000
    ? `${result.durationMs}ms`
    : `${(result.durationMs / 1000).toFixed(1)}s`;

  return (
    <div
      className="-mx-4 border-y border-[#1E1E23] bg-[#111116] px-4 py-2.5"
      data-testid="test-results-panel"
      data-test-status={result.status}
      aria-label="Test results"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <TestTube2
            className={cn(
              "h-4 w-4 shrink-0",
              passed ? "text-[var(--zoc-success)]" : "text-[var(--zoc-error)]",
            )}
          />
          <span className="shrink-0 text-[12px] font-semibold text-[#E4E4E7]">
            Tests
          </span>
          <code className="min-w-0 truncate text-[10.5px] text-[#71717A]" title={result.command}>
            {result.command}
          </code>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-[11px]">
          <span className="inline-flex items-center gap-1 text-[var(--zoc-success)]">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {result.passed} passed
          </span>
          <span className="inline-flex items-center gap-1 text-[var(--zoc-error)]">
            <XCircle className="h-3.5 w-3.5" />
            {result.failed} failed
          </span>
          <span className="font-mono text-[#52525B]">{duration}</span>
        </div>
      </div>
      {!passed && result.output && (
        <details className="group mt-2 border-t border-[#1E1E23] pt-2">
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-[#A1A1AA]">
            <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
            Test output
          </summary>
          <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap bg-black/30 p-2 font-mono text-[10.5px] leading-snug text-[#A1A1AA]">
            {result.output}
          </pre>
        </details>
      )}
    </div>
  );
}

function StageStepper({
  activeStage,
  status,
}: {
  activeStage: string;
  status: RunTrace["status"];
}): JSX.Element {
  const activeIndex = Math.max(0, STAGES.findIndex((s) => s.id === activeStage));
  const done = status === "done";
  const failed = status === "failed";

  return (
    <div className="flex items-end gap-1" aria-label="Agent stage">
      {STAGES.map((stage, index) => {
        const isCompleted = done || index < activeIndex;
        const isActive = !done && !failed && index === activeIndex;
        const isFailed = failed && index <= activeIndex;

        return (
          <div key={stage.id} className="flex-1 min-w-0">
            <div
              className={cn(
                "h-[3px] rounded-full transition-all duration-500",
                isCompleted
                  ? "bg-[var(--zoc-success)]"
                  : isFailed
                    ? "bg-[var(--zoc-error)]"
                    : isActive
                      ? "bg-[var(--zoc-agent)] animate-pulse"
                      : "bg-[#26262B]",
              )}
            />
            <div
              className={cn(
                "mt-1 truncate text-[10px]",
                isCompleted
                  ? "text-[var(--zoc-success)]"
                  : isActive
                    ? "text-[#8b7cf6] font-medium"
                    : "text-[#52525B]",
              )}
            >
              {stage.label}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TodoSection({ items }: { items: TracePlanItem[] }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#52525B]">
        Steps
      </div>
      <div className="flex flex-col gap-1">
        {items.map((item) => (
          <div key={item.id} className="flex min-w-0 items-center gap-2">
            {item.status === "done" ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--zoc-success)] zoc-check-pop" />
            ) : item.status === "active" ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--zoc-agent)]" />
            ) : (
              <Circle className="h-3.5 w-3.5 shrink-0 text-[#3F3F46]" />
            )}
            <span
              className={cn(
                "text-[12px] truncate",
                item.status === "done"
                  ? "line-through text-[#52525B]"
                  : item.status === "active"
                    ? "font-medium text-[#FAFAFA]"
                    : "text-[#71717A]",
              )}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ActivitySection({ activities }: { activities: TraceActivity[] }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-[#52525B]">
        Activity
      </div>
      <div className="flex flex-col overflow-hidden rounded-lg border border-[#1E1E23]">
        {activities.map((activity) => (
          <ActivityRow key={activity.id} activity={activity} />
        ))}
      </div>
    </div>
  );
}

function ActivityRow({ activity }: { activity: TraceActivity }): JSX.Element {
  const Icon = activityIcon(activity.kind);
  const iconColor = activityIconColor(activity.kind);
  return (
    <details
      className="group border-b border-[#1E1E23] last:border-b-0"
      data-activity-kind={activity.kind}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 bg-[#0F0F14] px-2.5 py-2 text-[12px] transition-colors hover:bg-[#141419]">
        <ChevronRight className="h-3 w-3 shrink-0 text-[#3F3F46] transition-transform duration-150 group-open:rotate-90" />
        <Icon className={cn("h-3.5 w-3.5 shrink-0", iconColor)} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-[#C8C8CE]">
          {activity.label}
        </span>
        {activity.meta && (
          <span className="shrink-0 text-[11px] text-[#52525B]">{activity.meta}</span>
        )}
      </summary>
      <div className="border-t border-[#1E1E23] bg-[#0b0e14] px-3 py-2.5 space-y-2">
        {activity.detail && (
          <p className="text-[12px] leading-snug text-[#A1A1AA] whitespace-pre-wrap">
            {activity.detail}
          </p>
        )}
        {activity.files && (
          <ul className="flex flex-col gap-0.5 font-mono text-[11px]">
            {activity.files.map((file, index) => (
              <li key={`${file.path}:${index}`} className="truncate text-[#71717A]">
                {file.path}
                {file.span && (
                  <span className="text-[#52525B]">:{file.span[0]}-{file.span[1]}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {activity.diff && <DiffPreview diff={activity.diff} />}
        {activity.output && (
          <pre className="max-h-44 overflow-auto rounded-md bg-black/40 p-2 font-mono text-[11px] leading-snug text-[#A1A1AA]">
            {activity.output}
          </pre>
        )}
      </div>
    </details>
  );
}

function ReviewChangesRow({
  runId,
  review,
}: {
  runId: string;
  review: TraceReview;
}): JSX.Element {
  const allPaths = useMemo(() => review.files.map((f) => f.path), [review.files]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(allPaths));
  const [pending, setPending] = useState<"apply" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setSelected(new Set(allPaths));
    setOpen(true);
  }, [allPaths]);

  const stats = useMemo(
    () =>
      review.files.reduce(
        (total, file) => ({
          adds: total.adds + file.adds,
          dels: total.dels + file.dels,
        }),
        { adds: 0, dels: 0 },
      ),
    [review.files],
  );

  const selectedCount = selected.size;
  const disabled = pending !== null;

  async function decide(decision: "apply" | "discard", paths = [...selected]): Promise<void> {
    setError(null);
    setPending(decision);
    try {
      await postAgentDecision({
        runId,
        decision,
        acceptedPaths: decision === "apply" ? paths : [],
      });
    } catch (err) {
      setError((err as Error).message);
      setPending(null);
    }
  }

  return (
    <div
      className="rounded-xl border border-[var(--zoc-ember)]/30 bg-[rgba(251,146,60,0.05)] p-3 space-y-3"
      data-testid="review-changes-row"
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-4 w-4 shrink-0 text-[var(--zoc-ember)]" />
          <span className="text-[12px] font-semibold text-[#FAFAFA]">Diff preview ready</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span className="rounded-md border border-[var(--zoc-success)]/30 bg-[var(--zoc-success)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--zoc-success)]">
            +{stats.adds}
          </span>
          <span className="rounded-md border border-[var(--zoc-error)]/30 bg-[var(--zoc-error)]/10 px-1.5 py-0.5 text-[10px] font-medium text-[var(--zoc-error)]">
            -{stats.dels}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ValidationBadges validation={review.validation} />
        <button
          type="button"
          className="rounded-lg border border-[#26262B] bg-[#15151A] px-3 py-1.5 text-[11.5px] font-medium text-[#C8C8CE] transition-colors hover:bg-[#1E1E23]"
          onClick={() => setOpen(true)}
        >
          Open diff preview
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/8 px-2.5 py-2 text-[11px] text-[var(--zoc-error)]">
          {error}
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => !disabled && setOpen(next)}>
        <DialogContent
          className="max-h-[88vh] w-[min(1180px,calc(100vw-32px))] max-w-none gap-0 overflow-hidden border-[#26262B] bg-[#0F0F14] p-0 text-[#FAFAFA]"
          data-testid="diff-preview-modal"
        >
          <DialogHeader className="border-b border-[#1E1E23] px-4 py-3">
            <DialogTitle className="flex min-w-0 items-center gap-2 text-[14px]">
              <FileDiff className="h-4 w-4 shrink-0 text-[var(--zoc-ember)]" />
              <span className="truncate">Review file changes</span>
            </DialogTitle>
            <DialogDescription className="text-[12px] text-[#71717A]">
              Only accepted files are written to disk.
            </DialogDescription>
          </DialogHeader>

          <div className="max-h-[calc(88vh-138px)] overflow-auto px-4 py-3">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="rounded-md border border-[#26262B] bg-[#15151A] px-2 py-1 text-[11px] text-[#C8C8CE]">
                  {selectedCount}/{review.files.length} accepted
                </span>
                <span className="rounded-md border border-[var(--zoc-success)]/30 bg-[var(--zoc-success)]/10 px-2 py-1 text-[11px] text-[var(--zoc-success)]">
                  +{stats.adds}
                </span>
                <span className="rounded-md border border-[var(--zoc-error)]/30 bg-[var(--zoc-error)]/10 px-2 py-1 text-[11px] text-[var(--zoc-error)]">
                  -{stats.dels}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  className="rounded-lg border border-[#26262B] bg-[#15151A] px-2.5 py-1.5 text-[11.5px] text-[#C8C8CE] hover:bg-[#1E1E23] disabled:opacity-40"
                  disabled={disabled}
                  onClick={() => setSelected(new Set(allPaths))}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className="rounded-lg border border-[#26262B] bg-[#15151A] px-2.5 py-1.5 text-[11.5px] text-[#C8C8CE] hover:bg-[#1E1E23] disabled:opacity-40"
                  disabled={disabled}
                  onClick={() => setSelected(new Set())}
                >
                  Clear
                </button>
              </div>
            </div>

            <div className="flex flex-col gap-3">
              {review.files.map((file) => (
                <ReviewFileDiffPanel
                  key={file.path}
                  file={file}
                  checked={selected.has(file.path)}
                  disabled={disabled}
                  onCheckedChange={(checked) => {
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(file.path);
                      else next.delete(file.path);
                      return next;
                    });
                  }}
                />
              ))}
            </div>
          </div>

          <DialogFooter className="border-t border-[#1E1E23] bg-[#101015] px-4 py-3">
            <button
              type="button"
              className="rounded-lg border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/10 px-3 py-1.5 text-[11.5px] font-medium text-[var(--zoc-error)] transition-colors hover:bg-[var(--zoc-error)]/18 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
              onClick={() => void decide("discard", [])}
            >
              {pending === "discard" ? "Rejecting…" : "Reject all"}
            </button>
            <button
              type="button"
              className="rounded-lg border border-[#26262B] bg-[#15151A] px-3 py-1.5 text-[11.5px] font-medium text-[#C8C8CE] transition-colors hover:bg-[#1E1E23] disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled}
              onClick={() => void decide("apply", allPaths)}
            >
              Accept all
            </button>
            <button
              type="button"
              className="rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/12 px-3 py-1.5 text-[11.5px] font-semibold text-[var(--zoc-success)] transition-colors hover:bg-[var(--zoc-success)]/20 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={disabled || selectedCount === 0}
              onClick={() => void decide("apply")}
            >
              {pending === "apply"
                ? "Applying…"
                : `Accept selected (${selectedCount})`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ReviewFileDiffPanel({
  file,
  checked,
  disabled,
  onCheckedChange,
}: {
  file: TraceReviewFile;
  checked: boolean;
  disabled: boolean;
  onCheckedChange: (checked: boolean) => void;
}): JSX.Element {
  return (
    <section className="overflow-hidden rounded-lg border border-[#1E1E23] bg-[#0B0B10]">
      <div className="flex min-w-0 items-center gap-2 border-b border-[#1E1E23] bg-[#121218] px-3 py-2">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 shrink-0 accent-[var(--zoc-agent)]"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onCheckedChange(e.currentTarget.checked)}
          aria-label={`Accept ${file.path}`}
        />
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-[var(--zoc-ember)]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#C8C8CE]">
          {file.path}
        </span>
        <span className="shrink-0 text-[10px] text-[var(--zoc-success)]">+{file.adds}</span>
        <span className="shrink-0 text-[10px] text-[var(--zoc-error)]">-{file.dels}</span>
      </div>
      <div className="bg-[#0b0e14] p-2.5">
        {file.summary && (
          <p className="mb-2 text-[11.5px] text-[#A1A1AA]">{file.summary}</p>
        )}
        <SideBySideDiff diff={file.diff} />
      </div>
    </section>
  );
}

function SideBySideDiff({ diff }: { diff: string }): JSX.Element {
  const rows = sideBySideRows(diff).slice(0, 180);
  return (
    <div className="overflow-auto rounded-md border border-[#1E1E23] bg-black/30 font-mono text-[11px] leading-snug">
      <div className="grid min-w-[760px] grid-cols-[72px_minmax(0,1fr)_72px_minmax(0,1fr)] border-b border-[#1E1E23] bg-[#111827] text-[10px] font-semibold uppercase tracking-wide text-[#A1A1AA]">
        <div className="border-r border-[#1E1E23] px-2 py-1.5 text-right">Old</div>
        <div className="border-r border-[#1E1E23] px-2 py-1.5">Before</div>
        <div className="border-r border-[#1E1E23] px-2 py-1.5 text-right">New</div>
        <div className="px-2 py-1.5">After</div>
      </div>
      {rows.map((row) =>
        row.kind === "header" ? (
          <div
            key={row.id}
            className="grid min-w-[760px] grid-cols-[72px_minmax(0,1fr)_72px_minmax(0,1fr)] border-b border-[#1E1E23] bg-[#0f172a] text-[#60a5fa]"
          >
            <div className="border-r border-[#1E1E23] px-2 py-1 text-right text-[#64748b]" />
            <div className="col-span-3 px-2 py-1">{row.oldText}</div>
          </div>
        ) : (
          <div
            key={row.id}
            className="grid min-w-[760px] grid-cols-[72px_minmax(0,1fr)_72px_minmax(0,1fr)] border-b border-[#111827] last:border-b-0"
          >
            <div className="border-r border-[#1E1E23] px-2 py-1 text-right text-[#52525B]">
              {row.oldNum ?? ""}
            </div>
            <div className={cn("border-r border-[#1E1E23] px-2 py-1 whitespace-pre", oldLineTone(row.kind))}>
              {row.oldText || " "}
            </div>
            <div className="border-r border-[#1E1E23] px-2 py-1 text-right text-[#52525B]">
              {row.newNum ?? ""}
            </div>
            <div className={cn("px-2 py-1 whitespace-pre", newLineTone(row.kind))}>
              {row.newText || " "}
            </div>
          </div>
        ),
      )}
    </div>
  );
}

function sideBySideRows(diff: string): SideBySideLine[] {
  const parsed = parseUnifiedDiff(diff);
  const rows: SideBySideLine[] = [];
  for (const [hunkIndex, hunk] of parsed.hunks.entries()) {
    if (hunk.header) {
      rows.push({
        id: `h:${hunkIndex}`,
        kind: "header",
        oldText: hunk.header,
        newText: hunk.header,
      });
    }
    for (let i = 0; i < hunk.lines.length; i += 1) {
      const line = hunk.lines[i];
      const next = hunk.lines[i + 1];
      if (line.kind === "del" && next?.kind === "add") {
        rows.push({
          id: `${hunkIndex}:${i}:replace`,
          kind: "replace",
          oldNum: line.oldNum,
          newNum: next.newNum,
          oldText: line.text,
          newText: next.text,
        });
        i += 1;
      } else if (line.kind === "del") {
        rows.push({
          id: `${hunkIndex}:${i}:del`,
          kind: "del",
          oldNum: line.oldNum,
          oldText: line.text,
          newText: "",
        });
      } else if (line.kind === "add") {
        rows.push({
          id: `${hunkIndex}:${i}:add`,
          kind: "add",
          newNum: line.newNum,
          oldText: "",
          newText: line.text,
        });
      } else {
        rows.push({
          id: `${hunkIndex}:${i}:ctx`,
          kind: "ctx",
          oldNum: line.oldNum,
          newNum: line.newNum,
          oldText: line.text,
          newText: line.text,
        });
      }
    }
  }
  return rows;
}

function oldLineTone(kind: SideBySideLine["kind"]): string {
  if (kind === "del" || kind === "replace") {
    return "bg-[#7f1d1d]/18 text-[#fca5a5]";
  }
  if (kind === "add") {
    return "bg-[#111827] text-[#3F3F46]";
  }
  return "text-[#A1A1AA]";
}

function newLineTone(kind: SideBySideLine["kind"]): string {
  if (kind === "add" || kind === "replace") {
    return "bg-[#14532d]/16 text-[#86efac]";
  }
  if (kind === "del") {
    return "bg-[#111827] text-[#3F3F46]";
  }
  return "text-[#A1A1AA]";
}

function DiffPreview({ diff }: { diff: string }): JSX.Element {
  const parsed = parseUnifiedDiff(diff);
  const lines = diff.split("\n").slice(0, 120);
  return (
    <pre
      className="max-h-52 overflow-auto rounded-md bg-black/40 p-2.5 font-mono text-[11px] leading-snug"
      data-diff-adds={parsed.adds}
      data-diff-dels={parsed.dels}
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            "block",
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-[#4ade80] bg-[#4ade80]/5"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-[#f87171] bg-[#f87171]/5"
                : line.startsWith("@@")
                  ? "text-[#60a5fa]"
                  : "text-[#71717A]",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

function ValidationBadges({ validation }: { validation: TraceReview["validation"] }): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <ValidationBadge label="typecheck" status={validation.typecheck.status} />
      <ValidationBadge label="build" status={validation.build.status} />
      <ValidationBadge label="tests" status={validation.tests.status} />
    </div>
  );
}

function ValidationBadge({ label, status }: { label: string; status: string }): JSX.Element {
  const tone =
    status === "pass"
      ? "border-[var(--zoc-success)]/30 bg-[var(--zoc-success)]/8 text-[var(--zoc-success)]"
      : status === "fail"
        ? "border-[var(--zoc-error)]/30 bg-[var(--zoc-error)]/8 text-[var(--zoc-error)]"
        : "border-[#26262B] bg-[#15151A] text-[#71717A]";
  return (
    <span className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${tone}`}>
      {label}: {status}
    </span>
  );
}

function activityIcon(kind: TraceActivity["kind"]) {
  if (kind === "thinking")   return Brain;
  if (kind === "read-files") return FileText;
  if (kind === "edit-file")  return FileDiff;
  if (kind === "command")    return Terminal;
  if (kind === "error")      return XCircle;
  return ClipboardCheck;
}

function activityIconColor(kind: TraceActivity["kind"]): string {
  if (kind === "thinking")   return "text-[var(--zoc-agent)]";
  if (kind === "read-files") return "text-[var(--zoc-info)]";
  if (kind === "edit-file")  return "text-[var(--zoc-ember)]";
  if (kind === "command")    return "text-[var(--zoc-info)]";
  if (kind === "error")      return "text-[var(--zoc-error)]";
  return "text-[var(--zoc-text-muted)]";
}

function statusLabel(trace: RunTrace): string {
  if (trace.status === "awaiting_review") return "Awaiting review";
  if (trace.status === "done")   return trace.doneReason ?? "Completed";
  if (trace.status === "failed") return trace.doneReason ?? "Failed";
  if (trace.status === "paused") return "Paused";
  const active = trace.planItems.find((i) => i.status === "active");
  return active?.label ?? "Running…";
}
