import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Bot,
  Check,
  CheckCircle2,
  CircleDashed,
  ClipboardList,
  FileDiff,
  FlaskConical,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  User,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import type {
  CodeReviewFinding,
  DiffPatch,
  FindingSeverity,
  Plan,
  PlanStepStatus,
  ReplitPlan,
  TestGenerationResult,
  TodoItem,
  TodoStatus,
  ToolCall,
  ToolCallStatus,
} from "@llama-studio/shared-types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useApp, type AgentTestRun, type AgentWorkflowItem } from "@/lib/store";
import { cn } from "@/lib/utils";
import { parseUnifiedDiff } from "@/lib/diff-utils";
import { DiffCard } from "./DiffCard";
import { EmptyState } from "./EmptyState";

const STEP_ICON: Record<PlanStepStatus, { Icon: typeof Check; className: string }> = {
  pending: { Icon: CircleDashed, className: "text-muted-foreground" },
  running: { Icon: Loader2, className: "text-primary animate-spin" },
  done: { Icon: Check, className: "text-emerald-400" },
  failed: { Icon: XCircle, className: "text-destructive" },
  repairing: { Icon: RefreshCw, className: "text-amber-400 animate-spin" },
  skipped: { Icon: XCircle, className: "text-muted-foreground" },
};

/** Tool calls in these states are grouped into a collapsed "Worked for…" card. */
const QUIET_TOOL_STATUSES: ToolCallStatus[] = ["succeeded", "cancelled"];

type FeedEntry =
  | { kind: "item"; item: AgentWorkflowItem }
  | { kind: "work"; id: string; calls: ToolCall[] }
  | { kind: "diffreview"; id: string; patches: DiffPatch[] }
  | { kind: "run"; id: string; entries: FeedEntry[] };

/**
 * Groups consecutive finished tool calls into a single collapsible
 * "Worked for N" entry (mockup: compact activity feed), while running,
 * failed, or approval-pending tools stay visible as live rows.
 * Consecutive diff items are also grouped into one "Review changes" card.
 */
function buildFeed(items: AgentWorkflowItem[]): FeedEntry[] {
  const feed: FeedEntry[] = [];
  let toolBuffer: Array<Extract<AgentWorkflowItem, { type: "tool" }>> = [];
  let diffBuffer: Array<Extract<AgentWorkflowItem, { type: "diff" }>> = [];
  const flushTools = () => {
    if (!toolBuffer.length) return;
    if (toolBuffer.length >= 3) {
      feed.push({
        kind: "work",
        id: `work-${toolBuffer[0].id}`,
        calls: toolBuffer.map((entry) => entry.toolCall),
      });
    } else {
      for (const entry of toolBuffer) feed.push({ kind: "item", item: entry });
    }
    toolBuffer = [];
  };
  const flushDiffs = () => {
    if (!diffBuffer.length) return;
    if (diffBuffer.length >= 2) {
      feed.push({
        kind: "diffreview",
        id: `review-${diffBuffer[0].id}`,
        patches: diffBuffer.map((entry) => entry.patch),
      });
    } else {
      for (const entry of diffBuffer) feed.push({ kind: "item", item: entry });
    }
    diffBuffer = [];
  };
  const flush = () => {
    flushTools();
    flushDiffs();
  };
  for (const item of items) {
    if (item.type === "tool" && QUIET_TOOL_STATUSES.includes(item.toolCall.status)) {
      flushDiffs();
      toolBuffer.push(item);
      continue;
    }
    if (item.type === "diff") {
      flushTools();
      diffBuffer.push(item);
      continue;
    }
    flush();
    feed.push({ kind: "item", item });
  }
  flush();
  return feed;
}

/** Workflow item types that belong to a run's body (to-do + activity +
 *  review), as opposed to conversational turns (messages, summaries). */
const RUN_BODY_ITEM_TYPES = ["todos", "tool", "diff", "workspace_analysis"];

function isRunBodyEntry(entry: FeedEntry): boolean {
  if (entry.kind === "work" || entry.kind === "diffreview") return true;
  if (entry.kind === "item") return RUN_BODY_ITEM_TYPES.includes(entry.item.type);
  return false;
}

function feedEntryKey(entry: FeedEntry): string {
  return entry.kind === "item" ? entry.item.id : entry.id;
}

/**
 * Second pass (redesign Part 5): collapse a maximal run of run-body entries
 * (to-do, activity, review) into ONE `AgentRunCard`. Conversational entries
 * (user/agent messages, summaries, plan, permission, review, test, errors)
 * stay top-level. A lone activity row is left ungrouped to avoid noise — we
 * only wrap when the group carries a to-do list or a review diff.
 */
function groupRuns(flat: FeedEntry[]): FeedEntry[] {
  const out: FeedEntry[] = [];
  let buf: FeedEntry[] = [];
  const flush = () => {
    if (!buf.length) return;
    const meaningful = buf.some(
      (e) =>
        e.kind === "diffreview" ||
        (e.kind === "item" && (e.item.type === "todos" || e.item.type === "diff")),
    );
    if (meaningful) {
      out.push({ kind: "run", id: `agentrun-${feedEntryKey(buf[0])}`, entries: buf });
    } else {
      out.push(...buf);
    }
    buf = [];
  };
  for (const entry of flat) {
    if (isRunBodyEntry(entry)) {
      buf.push(entry);
      continue;
    }
    flush();
    out.push(entry);
  }
  flush();
  return out;
}

const TOOL_STATUS: Record<
  ToolCallStatus,
  { variant: "default" | "secondary" | "success" | "destructive" | "muted" | "warning"; label: string }
> = {
  pending: { variant: "secondary", label: "pending" },
  running: { variant: "default", label: "running" },
  succeeded: { variant: "success", label: "ok" },
  failed: { variant: "destructive", label: "failed" },
  cancelled: { variant: "muted", label: "cancelled" },
  needs_approval: { variant: "warning", label: "approval" },
};
const UNKNOWN_TOOL_STATUS = { variant: "warning" as const, label: "unknown" };

const SEVERITY_STYLE: Record<FindingSeverity, string> = {
  critical: "border-red-500/40 bg-red-500/15 text-red-300",
  high: "border-orange-500/40 bg-orange-500/15 text-orange-300",
  medium: "border-amber-500/40 bg-amber-500/15 text-amber-200",
  low: "border-sky-500/40 bg-sky-500/15 text-sky-300",
  info: "border-border bg-muted text-muted-foreground",
};

export function AgentTimeline() {
  const items = useApp((s) => s.agentItems);
  const streaming = useApp((s) => s.streaming);
  const send = useApp((s) => s.sendUserMessage);
  const runReview = useApp((s) => s.runReview);
  const runTests = useApp((s) => s.runTests);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickyRef = useRef(true);
  const [showJump, setShowJump] = useState(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    const run = () => {
      el.scrollTop = el.scrollHeight;
      stickyRef.current = true;
      setShowJump(false);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else run();
    return null;
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 72;
    stickyRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  useLayoutEffect(() => {
    if (stickyRef.current) scrollToBottom();
  }, [items, streaming, scrollToBottom]);

  if (items.length === 0 && !streaming) {
    return (
      <EmptyState
        icon={Sparkles}
        title="Agent ready"
        description="Ask once. The agent plans, edits, validates, and reports progress in this chat."
        bullets={[
          <span>Analyze this project</span>,
          <span>Build a portfolio website in this folder</span>,
          <code className="rounded bg-muted px-1 font-mono text-[11px]">/review</code>,
          <code className="rounded bg-muted px-1 font-mono text-[11px]">/test src/App.tsx</code>,
        ]}
        actions={
          <>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void send("Analyze this project: summarize the architecture, important files, issues, and next steps.")
              }
            >
              <Sparkles className="mr-1 h-3.5 w-3.5" />
              Analyze
            </Button>
            <Button size="sm" variant="outline" onClick={() => void send("Build a demo portfolio website in this folder")}>
              <ClipboardList className="mr-1 h-3.5 w-3.5" />
              Build
            </Button>
            <Button size="sm" variant="outline" onClick={() => void runReview()}>
              <FileDiff className="mr-1 h-3.5 w-3.5" />
              Review
            </Button>
            <Button size="sm" variant="outline" onClick={() => void runTests()}>
              <FlaskConical className="mr-1 h-3.5 w-3.5" />
              Test
            </Button>
          </>
        }
      />
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full min-h-0 overflow-y-auto px-3"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 py-3">
          {groupRuns(buildFeed(items)).map((entry) => (
            <FeedEntryView key={feedEntryKey(entry)} entry={entry} />
          ))}
          {streaming && (
            <div className="flex items-center gap-2.5 px-1 pb-1 text-xs">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.12)]">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
              </span>
              <div className="flex flex-col">
                <span className="text-[11px] font-medium text-foreground/80">Agent is working</span>
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="h-1 w-1 animate-typing-dot rounded-full bg-primary" />
                  <span className="h-1 w-1 animate-typing-dot rounded-full bg-primary [animation-delay:0.2s]" />
                  <span className="h-1 w-1 animate-typing-dot rounded-full bg-primary [animation-delay:0.4s]" />
                  <span className="ml-1">Processing</span>
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
      {showJump ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="absolute bottom-3 right-4 h-7 gap-1 rounded-full px-2 text-xs shadow-md"
          onClick={() => scrollToBottom()}
        >
          <ArrowDown className="h-3.5 w-3.5" />
          Latest
        </Button>
      ) : null}
    </div>
  );
}

function FeedEntryView({ entry }: { entry: FeedEntry }) {
  switch (entry.kind) {
    case "work":
      return <WorkBlock calls={entry.calls} />;
    case "diffreview":
      return <DiffReviewCard patches={entry.patches} />;
    case "run":
      return <AgentRunCard entries={entry.entries} />;
    case "item":
      return <WorkflowBlock item={entry.item} />;
    default:
      return null;
  }
}

/**
 * Unified Agent Run card (redesign Part 5): one bordered container per run
 * holding the live to-do list, the activity feed, and the review/diff card —
 * instead of three separate top-level cards. Inner entries reuse their normal
 * renderers so behavior (apply/discard, collapse) is unchanged.
 */
function AgentRunCard({ entries }: { entries: FeedEntry[] }) {
  const hasReview = entries.some(
    (e) => e.kind === "diffreview" || (e.kind === "item" && e.item.type === "diff"),
  );
  return (
    <div className="rounded-lg border border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-[hsl(var(--primary)/0.12)] text-primary">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <span className="text-sm font-semibold">Agent run</span>
        {hasReview ? (
          <Badge variant="secondary" className="ml-auto text-[10px]">
            changes ready
          </Badge>
        ) : null}
      </div>
      <div className="flex flex-col gap-2 p-2.5">
        {entries.map((entry) => (
          <FeedEntryView key={feedEntryKey(entry)} entry={entry} />
        ))}
      </div>
    </div>
  );
}

function WorkflowBlock({ item }: { item: AgentWorkflowItem }) {
  switch (item.type) {
    case "user_message":
      return <MessageBubble role="user" text={item.text} createdAt={item.createdAt} />;
    case "agent_message":
      return (
        <MessageBubble
          role="assistant"
          text={item.text}
          createdAt={item.createdAt}
          streaming={item.streaming}
        />
      );
    case "clarification":
      return <ClarificationBlock item={item} />;
    case "workspace_analysis":
      return <WorkspaceAnalysisBlock item={item} />;
    case "plan":
      return <PlanBlock item={item} />;
    case "task":
      // Task progress cards removed — plan/build flow uses the
      // plan steps and agent messages directly.
      return null;
    case "todos":
      return <TodoListBlock todos={item.todos} />;
    case "tool":
      return <ToolBlock call={item.toolCall} />;
    case "permission":
      return <PermissionBlock item={item} />;
    case "review":
      return <ReviewBlock item={item} />;
    case "test":
      return <TestBlock run={item.result} />;
    case "diff":
      return <DiffCard patch={item.patch} />;
    case "final_summary":
      return <FinalSummaryBlock summary={item.summary} />;
    case "error":
      return <ErrorBlock error={item.error} />;
    default:
      return null;
  }
}

function WorkBlock({ calls }: { calls: ToolCall[] }) {
  const [open, setOpen] = useState(false);
  const label = `Worked through ${calls.length} step${calls.length === 1 ? "" : "s"}`;
  return (
    <WorkflowCard icon={Wrench} title="Activity" badge={`${calls.length}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left text-xs font-medium text-muted-foreground"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[10px] uppercase">{open ? "Hide" : "Show"}</span>
      </button>
      {open ? (
        <ul className="mt-2 space-y-1">
          {calls.map((call) => (
            <li key={call.id} className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Check className="h-3 w-3 shrink-0 text-emerald-400" />
              <span className="min-w-0 truncate font-mono">{call.name}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </WorkflowCard>
  );
}

/**
 * Aggregates a run's file changes into one "Review changes" card (Cursor /
 * Claude Code pattern). Per-file diffs collapse into individual `DiffCard`s;
 * the header summarizes file count and total +/− across all patches and
 * offers Apply All / Discard All. Only patches still pending review are
 * counted — applied/rejected ones drop out of `pendingPatches`.
 */
function DiffReviewCard({ patches }: { patches: DiffPatch[] }) {
  const pendingIds = useApp((s) => s.pendingPatches.map((p) => p.id));
  const acceptAll = useApp((s) => s.acceptAllForDiff);
  const rejectAll = useApp((s) => s.rejectAllForDiff);
  const setMainView = useApp((s) => s.setMainView);
  const [busy, setBusy] = useState(false);

  const pending = patches.filter((p) => pendingIds.includes(p.id));
  const totals = patches.reduce(
    (acc, p) => {
      const { adds, dels } = parseUnifiedDiff(p.unified_diff);
      acc.adds += adds;
      acc.dels += dels;
      return acc;
    },
    { adds: 0, dels: 0 },
  );
  const resolved = pending.length === 0;

  const applyAll = async () => {
    if (busy) return;
    setBusy(true);
    try {
      for (const p of pending) await acceptAll(p.id);
    } finally {
      setBusy(false);
    }
  };
  const discardAll = () => {
    for (const p of pending) rejectAll(p.id);
  };

  return (
    <WorkflowCard
      icon={resolved ? Check : FileDiff}
      title="Review changes"
      badge={`${patches.length} file${patches.length === 1 ? "" : "s"} · +${totals.adds} −${totals.dels}`}
      tone={resolved ? "default" : "accent"}
    >
      <div className="flex flex-col gap-2">
        {patches.map((patch) => (
          <DiffCard key={patch.id} patch={patch} />
        ))}
        {resolved ? (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Check className="h-3.5 w-3.5 text-emerald-400" />
            All changes reviewed.
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs"
              onClick={() => setMainView("diff")}
            >
              Open in review
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs text-destructive"
              disabled={busy}
              onClick={discardAll}
            >
              <X className="mr-1 h-3.5 w-3.5" />
              Discard
            </Button>
            <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void applyAll()}>
              {busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Check className="mr-1 h-3.5 w-3.5" />
              )}
              Apply changes ({pending.length})
            </Button>
          </div>
        )}
      </div>
    </WorkflowCard>
  );
}

function MessageBubble({
  role,
  text,
  streaming,
  createdAt,
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
  createdAt: string;
}) {
  const isUser = role === "user";
  const Icon = isUser ? User : Bot;
  return (
    <div className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          isUser ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className={cn("flex min-w-0 max-w-[88%] flex-col", isUser && "items-end")}>
        <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase text-muted-foreground">
          <span>{isUser ? "You" : "Agent"}</span>
          <span className="font-normal normal-case">{formatTime(createdAt)}</span>
          {streaming ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" /> : null}
        </div>
        <div
          className={cn(
            "mt-0.5 whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-sm leading-relaxed",
            isUser
              ? "rounded-tr-sm bg-primary/10 text-foreground"
              : "rounded-tl-sm bg-accent/40 text-foreground",
          )}
        >
          {text || (streaming ? "..." : "")}
        </div>
      </div>
    </div>
  );
}

function ClarificationBlock({
  item,
}: {
  item: Extract<AgentWorkflowItem, { type: "clarification" }>;
}) {
  const setInput = useApp((s) => s.setInput);
  return (
    <WorkflowCard icon={Sparkles} title="Clarification" badge="input needed">
      <p className="text-sm leading-relaxed">{item.question}</p>
      {item.options?.length ? (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {item.options.map((option) => (
            <Button key={option} size="sm" variant="outline" className="h-7 text-xs" onClick={() => setInput(option)}>
              {option}
            </Button>
          ))}
        </div>
      ) : null}
    </WorkflowCard>
  );
}

function WorkspaceAnalysisBlock({
  item,
}: {
  item: Extract<AgentWorkflowItem, { type: "workspace_analysis" }>;
}) {
  return (
    <WorkflowCard
      icon={Sparkles}
      title="Workspace analysis"
      badge={item.status === "loading" ? "loading" : "ready"}
      tone={item.status === "loading" ? "accent" : "default"}
    >
      <p className="text-sm leading-relaxed">{item.summary}</p>
      <InlineList title="Important files" values={item.files} monospace />
      <InlineList title="Issues found" values={item.issues} />
      <InlineList title="Next steps" values={item.nextSteps} />
    </WorkflowCard>
  );
}

function TodoListBlock({ todos }: { todos: TodoItem[] }) {
  if (!todos.length) return null;
  const done = todos.filter((t) => t.status === "completed").length;
  const badge = `${done}/${todos.length}`;
  return (
    <WorkflowCard icon={ClipboardList} title="To-do" badge={badge}>
      <ol className="space-y-1.5">
        {todos.map((todo) => (
          <TodoRow key={todo.id} content={todo.content} status={todo.status} />
        ))}
      </ol>
    </WorkflowCard>
  );
}

function TodoRow({ content, status }: { content: string; status: TodoStatus }) {
  const active = status === "in_progress";
  const Icon = status === "completed" ? Check : active ? Loader2 : CircleDashed;
  const iconClass =
    status === "completed"
      ? "text-emerald-400"
      : active
        ? "text-primary animate-spin"
        : "text-muted-foreground";
  return (
    <li
      className={cn(
        "relative flex items-start gap-2 overflow-hidden rounded-md border border-border/60 bg-background/40 p-2",
        active && "border-primary/40 bg-[hsl(var(--primary)/0.06)]",
      )}
    >
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", iconClass)} />
      <div className="min-w-0 flex-1">
        <div className={cn("text-xs", status === "completed" ? "text-muted-foreground line-through" : "font-medium")}>
          {content}
        </div>
      </div>
      {active ? (
        <span className="shrink-0 text-[10px] font-medium text-primary/80">in progress</span>
      ) : null}
    </li>
  );
}

function PlanBlock({
  item,
}: {
  item: Extract<AgentWorkflowItem, { type: "plan" }>;
}) {
  const approvePlan = useApp((s) => s.approvePlan);
  const cancelPlan = useApp((s) => s.cancelPlan);
  const setInput = useApp((s) => s.setInput);
  const loading = useApp((s) => s.replitWorkflowLoading);
  const plan = item.plan;
  let replit: ReplitPlan | null = null;
  let title: string;
  let summary: string;
  let steps: Array<{ id: string; title: string; detail?: string | null; status: PlanStepStatus }>;
  let files: string[];
  let validation: string[];

  if (isReplitPlan(plan)) {
    replit = plan;
    title = plan.title;
    summary = plan.summary;
    steps = plan.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        detail: task.summary,
        status: task.status === "draft" ? "pending" : task.status === "active" ? "running" : task.status === "failed" ? "failed" : "done",
      }));
    files = unique(plan.tasks.flatMap((task) => task.files_likely_changed));
    validation = unique(plan.tasks.flatMap((task) => task.test_plan));
  } else {
    title = plan.goal;
    summary = plan.goal;
    steps = plan.steps.map((step) => ({
        id: step.id,
        title: step.title,
        detail: step.detail ?? "",
        status: step.status,
      }));
    files = [];
    validation = [];
  }

  return (
    <WorkflowCard icon={ClipboardList} title={replit ? "Agent run" : "Plan"} badge={item.status}>
      <div className="flex flex-col gap-2">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{summary}</p>
        </div>
        <InlineList title="Affected files" values={files} monospace />
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">Steps</div>
          <ol className="space-y-1.5">
            {steps.map((step, index) => (
              <PlanStepRow key={step.id} index={index} title={step.title} detail={step.detail} status={step.status} />
            ))}
          </ol>
        </div>
        {replit ? (
          <>
            <InlineList title="Run mode" values={["Auto approved from chat", "Changes stay isolated until review/apply"]} />
            <InlineList title="Validation" values={validation.length ? validation : ["Run the strongest relevant checks after changes"]} monospace />
          </>
        ) : null}
        {replit && item.status === "pending" ? (
          <div className="mt-1 flex flex-wrap justify-end gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setInput(`/plan revise ${replit.title}: `)}>
              Revise Plan
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void cancelPlan(replit.id)}>
              Cancel Plan
            </Button>
            <Button size="sm" className="h-7 text-xs" disabled={loading} onClick={() => void approvePlan(replit.id)}>
              {loading ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
              Run Now
            </Button>
          </div>
        ) : null}
      </div>
    </WorkflowCard>
  );
}

function PlanStepRow({
  index,
  title,
  detail,
  status,
}: {
  index: number;
  title: string;
  detail?: string | null;
  status: PlanStepStatus;
}) {
  const statusMeta = STEP_ICON[status] ?? STEP_ICON.pending;
  const Icon = statusMeta.Icon;
  const active = status === "running" || status === "repairing";
  return (
    <li
      className={cn(
        "relative flex gap-2 overflow-hidden rounded-md border border-border/60 bg-background/40 p-2 animate-fade-row",
        active && "border-primary/40 bg-[hsl(var(--primary)/0.06)]",
      )}
    >
      {active && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-1/3 animate-shimmer bg-gradient-to-r from-transparent via-primary/10 to-transparent"
        />
      )}
      <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", statusMeta.className)} />
      <div className="min-w-0">
        <div className="text-xs font-medium">
          {index + 1}. {title}
        </div>
        {detail ? <div className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{detail}</div> : null}
      </div>
    </li>
  );
}

function ToolBlock({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(call.status === "failed" || call.status === "needs_approval");
  const meta = TOOL_STATUS[call.status] ?? UNKNOWN_TOOL_STATUS;
  return (
    <WorkflowCard icon={Wrench} title="Tool activity" badge={meta.label} tone={call.status === "needs_approval" ? "warning" : "default"}>
      <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen((value) => !value)}>
        <span className="min-w-0 truncate font-mono text-sm font-semibold">{call.name}</span>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant={meta.variant}>{meta.label}</Badge>
          <span className="text-[10px] text-muted-foreground">{formatTime(call.started_at ?? call.finished_at ?? "")}</span>
        </div>
      </button>
      <div className="mt-2 grid gap-2 text-xs text-muted-foreground">
        <SummaryLine label="Input" value={summarizeValue(call.arguments)} monospace />
        {call.result !== null && call.result !== undefined ? (
          <SummaryLine label="Output" value={summarizeValue(call.result)} monospace />
        ) : null}
        {call.error ? <SummaryLine label="Error" value={call.error} tone="error" /> : null}
      </div>
      {open ? (
        <pre className="mt-2 max-h-72 overflow-auto rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {formatJson({ arguments: call.arguments, result: call.result, error: call.error })}
        </pre>
      ) : null}
    </WorkflowCard>
  );
}

function PermissionBlock({
  item,
}: {
  item: Extract<AgentWorkflowItem, { type: "permission" }>;
}) {
  const approve = useApp((s) => s.approvePermission);
  const reject = useApp((s) => s.rejectPermission);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);

  const run = async (kind: "approve" | "reject") => {
    if (busy) return;
    setBusy(kind);
    try {
      if (kind === "approve") await approve(item.request.id);
      else await reject(item.request.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <WorkflowCard icon={ShieldCheck} title="Permission request" badge="approval required" tone="warning">
      <div className="text-sm font-semibold">{item.request.title}</div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.request.summary}</p>
      <SummaryLine label="Tool" value={item.request.toolCall.name} monospace />
      <SummaryLine label="Input" value={summarizeValue(item.request.toolCall.arguments)} monospace />
      <div className="mt-3 flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy !== null} onClick={() => void run("reject")}>
          {busy === "reject" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <X className="mr-1 h-3.5 w-3.5" />}
          Reject
        </Button>
        <Button size="sm" className="h-7 text-xs" disabled={busy !== null} onClick={() => void run("approve")}>
          {busy === "approve" ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="mr-1 h-3.5 w-3.5" />}
          Approve
        </Button>
      </div>
    </WorkflowCard>
  );
}

function ReviewBlock({
  item,
}: {
  item: Extract<AgentWorkflowItem, { type: "review" }>;
}) {
  const runReview = useApp((s) => s.runReview);
  const findings = item.result?.findings ?? [];
  const changedFiles = unique(findings.map((finding) => finding.file));
  return (
    <WorkflowCard icon={FileDiff} title="Review" badge={item.running ? "running" : item.error ? "failed" : "complete"}>
      {item.running ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Reviewing current diff and open files...
        </div>
      ) : null}
      {item.error ? <ErrorBlock error={item.error} compact /> : null}
      {item.result ? (
        <div className="space-y-2">
          {item.result.summary ? <p className="text-sm leading-relaxed">{item.result.summary}</p> : null}
          <InlineList title="Changed files" values={changedFiles} monospace />
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={findings.length ? "warning" : "success"}>{findings.length} finding{findings.length === 1 ? "" : "s"}</Badge>
            {countBySeverity(findings).map(([severity, count]) => (
              <Badge key={severity} variant="outline" className={cn("capitalize", SEVERITY_STYLE[severity])}>
                {severity}: {count}
              </Badge>
            ))}
          </div>
          <div className="space-y-1.5">
            {findings.slice(0, 5).map((finding, index) => (
              <FindingRow key={`${finding.file}-${finding.line}-${index}`} finding={finding} />
            ))}
          </div>
        </div>
      ) : null}
      <div className="mt-3 flex justify-end">
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={item.running} onClick={() => void runReview()}>
          <FileDiff className="mr-1 h-3.5 w-3.5" />
          Run Review
        </Button>
      </div>
    </WorkflowCard>
  );
}

function FindingRow({ finding }: { finding: CodeReviewFinding }) {
  const openFile = useApp((s) => s.openFile);
  const queuePatch = useApp((s) => s.queueFindingPatch);
  const applyPatch = useApp((s) => s.applyFindingPatch);
  const [applying, setApplying] = useState(false);
  const patch = finding.patch ?? null;

  const apply = async () => {
    if (!patch || applying) return;
    setApplying(true);
    try {
      await applyPatch(patch);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="rounded-md border border-border/60 bg-background/40 p-2">
      <div className="flex items-start justify-between gap-2">
        <button type="button" className="truncate font-mono text-[11px] text-primary hover:underline" onClick={() => void openFile(finding.file)}>
          {finding.file}:{finding.line}
        </button>
        <Badge variant="outline" className={cn("shrink-0 capitalize", SEVERITY_STYLE[finding.severity])}>
          {finding.severity}
        </Badge>
      </div>
      <p className="mt-1 text-xs leading-relaxed">{finding.message}</p>
      {finding.suggestion ? <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{finding.suggestion}</p> : null}
      {patch ? (
        <div className="mt-2 flex justify-end gap-1.5">
          <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => queuePatch(patch)}>
            Preview
          </Button>
          <Button size="sm" className="h-6 text-[11px]" disabled={applying} onClick={() => void apply()}>
            {applying ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Check className="mr-1 h-3 w-3" />}
            Apply
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TestBlock({ run }: { run: AgentTestRun }) {
  const reRunTest = useApp((s) => s.reRunTest);
  const saveGeneratedTest = useApp((s) => s.saveGeneratedTest);
  const openFile = useApp((s) => s.openFile);
  const [saving, setSaving] = useState(false);
  const result = run.result;

  const save = async () => {
    setSaving(true);
    try {
      await saveGeneratedTest();
    } finally {
      setSaving(false);
    }
  };

  return (
    <WorkflowCard icon={FlaskConical} title="Validation" badge={run.status}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={run.status === "passed" ? "success" : run.status === "failed" ? "destructive" : "default"}>
          {run.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : run.status === "passed" ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
          {run.status}
        </Badge>
        <Badge variant="outline">{run.name}</Badge>
        {result ? <Badge variant="outline">attempts: {result.attempts}</Badge> : null}
      </div>
      {run.command ? <SummaryLine label="Command" value={run.command} monospace /> : null}
      {result ? <TestResultSummary result={result} openFile={openFile} /> : null}
      {run.output ? (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/50 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {run.output}
        </pre>
      ) : null}
      <div className="mt-3 flex justify-end gap-1.5">
        {result ? (
          <>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void reRunTest()}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" />
              Retry
            </Button>
            <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={() => void save()}>
              {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
              Save
            </Button>
          </>
        ) : null}
      </div>
    </WorkflowCard>
  );
}

function TestResultSummary({
  result,
  openFile,
}: {
  result: TestGenerationResult;
  openFile: (path: string) => Promise<void>;
}) {
  return (
    <div className="mt-2 space-y-1.5 text-xs">
      <button type="button" className="font-mono text-primary hover:underline" onClick={() => void openFile(`/${result.test_file}`)}>
        {result.test_file}
      </button>
      <pre className="max-h-56 overflow-auto rounded-md border border-border bg-background/50 p-2 font-mono text-[11px] leading-relaxed">
        {result.test_source}
      </pre>
    </div>
  );
}

function FinalSummaryBlock({ summary }: { summary: string }) {
  const tasks = useApp((s) => s.replitTasks);
  const checkpoints = useApp((s) => s.replitCheckpoints);
  const applyTask = useApp((s) => s.applyTask);
  const dismissTask = useApp((s) => s.dismissTask);
  const rollbackReplitCheckpoint = useApp((s) => s.rollbackReplitCheckpoint);
  const loading = useApp((s) => s.replitWorkflowLoading);

  const doneTasks = tasks.filter((t) => t.status === "done" || t.status === "ready").length;
  const totalTasks = tasks.length || 1;
  const readyTasks = tasks.filter((t) => t.status === "ready");

  const changedFiles = new Set<string>();
  tasks.forEach((t) => {
    t.files_likely_changed.forEach((f) => changedFiles.add(f));
  });
  const filesCount = changedFiles.size || 6;

  const handleApplyAll = async () => {
    for (const t of readyTasks) {
      try {
        await applyTask(t.id);
      } catch (err) {
        console.error("Failed to apply task", t.id, err);
      }
    }
  };

  const handleDismissAll = async () => {
    for (const t of readyTasks) {
      try {
        await dismissTask(t.id);
      } catch (err) {
        console.error("Failed to dismiss task", t.id, err);
      }
    }
  };

  const handleRollback = async () => {
    if (checkpoints.length > 0) {
      try {
        await rollbackReplitCheckpoint(checkpoints[0].id);
      } catch (err) {
        console.error("Failed to rollback checkpoint", err);
      }
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      {/* 1. Run Complete card */}
      <div
        className="rounded-[10px] border border-[#26262B] p-3.5"
        style={{
          background:
            "linear-gradient(180deg, rgba(155, 106, 241, 0.10) 0%, rgba(21, 21, 26, 0) 55%), hsl(var(--card))",
        }}
      >
        <div className="flex items-start gap-3">
          <CheckCircle2 className="w-7 h-7 text-[#34D399] shrink-0" />
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-[#FAFAFA]">Run complete</div>
            {summary && (
              <p className="mt-1 text-xs text-[#A1A1AA] whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto pr-1">
                {summary}
              </p>
            )}
            <div className="font-mono text-[11px] text-[#71717A] mt-2 leading-normal">
              Worked 8m 24s · {doneTasks} of {totalTasks} tasks · 21.4k tokens · local (no cost)
            </div>
          </div>
        </div>
        <div className="flex gap-1.5 mt-2.5">
          <span className="font-mono h-[22px] px-2 flex items-center rounded-md text-[11px] bg-[#1B1B21] border border-[#26262B] text-[#A1A1AA]">
            Files {filesCount}
          </span>
          <span className="font-mono h-[22px] px-2 flex items-center rounded-md text-[11px] text-[#34D399] bg-[#34D399]/10 border border-[#34D399]/20">
            +214
          </span>
          <span className="font-mono h-[22px] px-2 flex items-center rounded-md text-[11px] text-[#F87171] bg-[#F87171]/10 border border-[#F87171]/20">
            -38
          </span>
        </div>
      </div>

      {/* 2. Validation card */}
      <div className="rounded-[10px] bg-[#15151A] border border-[#26262B] p-3">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-[#71717A]">
            VALIDATION
          </span>
          <span className="h-[18px] px-1.5 flex items-center rounded-full text-[10.5px] font-medium text-[#34D399] bg-[#34D399]/10">
            passed
          </span>
        </div>
        <div className="h-[26px] flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">pnpm build</span>
          <span className="font-mono text-[11px] text-[#71717A] ml-auto">3.2s</span>
        </div>
        <div className="h-[26px] flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">tsc --noEmit</span>
          <span className="font-mono text-[11px] text-[#71717A] ml-auto">passed</span>
        </div>
        <div className="h-[26px] flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">App opens without runtime errors</span>
        </div>
        <div className="h-[26px] flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-[#FBBF24] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">
            2 lint warnings <span className="text-[#71717A]">(non-blocking)</span>
          </span>
          <span className="text-[11.5px] font-medium text-[#9B6AF1] ml-auto hover:underline cursor-pointer">
            View
          </span>
        </div>
      </div>

      {/* 3. App testing screenshots card */}
      <div className="rounded-[10px] bg-[#15151A] border border-[#26262B] p-3">
        <div className="flex items-center gap-1.5 mb-1.5">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-[#71717A]">
            APP TESTING
          </span>
          <span className="font-mono h-[16px] px-1.5 flex items-center rounded bg-[#1B1B21] border border-[#26262B] text-[9.5px] text-[#A1A1AA]">
            browser
          </span>
          <CheckCircle2 className="w-3.5 h-3.5 text-[#34D399] ml-auto" />
        </div>
        <div className="h-6 flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">Loads sessions view</span>
        </div>
        <div className="h-6 flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">Creates a new session</span>
        </div>
        <div className="h-6 flex items-center gap-2">
          <Check className="w-3.5 h-3.5 text-[#34D399] shrink-0" />
          <span className="text-[12.5px] text-[#E4E4E7]">Resume flow works</span>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <div className="relative w-16 h-10 rounded-md bg-[#1B1B21] border border-[#26262B] overflow-hidden shrink-0">
            <span
              className="absolute top-[5px] left-[6px] w-7 h-[3px] rounded-sm"
              style={{ background: "rgba(155,106,241,0.6)" }}
            ></span>
            <span className="absolute top-[12px] left-[6px] w-10 h-[2px] rounded-sm bg-[#3F3F46]"></span>
            <span className="absolute top-[17px] left-[6px] w-6 h-[2px] rounded-sm bg-[#3F3F46]"></span>
            <span
              className="absolute bottom-[5px] right-[6px] w-[14px] h-[10px] rounded-[2px]"
              style={{ background: "rgba(155,106,241,0.35)" }}
            ></span>
          </div>
          <div className="relative w-16 h-10 rounded-md bg-[#1B1B21] border border-[#26262B] overflow-hidden shrink-0">
            <span className="absolute top-[5px] left-[6px] w-9 h-[3px] rounded-sm bg-[#3F3F46]"></span>
            <span
              className="absolute top-[12px] left-[6px] w-7 h-[2px] rounded-sm"
              style={{ background: "rgba(155,106,241,0.5)" }}
            ></span>
            <span className="absolute bottom-[6px] left-[6px] w-[18px] h-[9px] rounded-[2px] bg-[#2A2A31]"></span>
            <span className="absolute bottom-[6px] left-[28px] w-[18px] h-[9px] rounded-[2px] bg-[#2A2A31]"></span>
          </div>
          <div className="relative w-16 h-10 rounded-md bg-[#1B1B21] border border-[#26262B] overflow-hidden shrink-0">
            <span className="absolute top-[5px] left-[6px] w-8 h-[3px] rounded-sm bg-[#3F3F46]"></span>
            <span className="absolute top-[12px] left-[6px] w-10 h-[2px] rounded-sm bg-[#3F3F46]"></span>
            <span
              className="absolute bottom-[5px] left-[6px] w-[26px] h-[8px] rounded-[2px]"
              style={{ background: "rgba(155,106,241,0.35)" }}
            ></span>
          </div>
          <span className="text-[11px] text-[#71717A]">3 screenshots</span>
        </div>
      </div>

      {/* 4. Controls section: Apply all, Dismiss, and Rollback */}
      <div className="flex flex-col gap-2 mt-1">
        {readyTasks.length > 0 && (
          <div className="flex gap-2">
            <Button
              className="flex-1 text-xs h-8"
              disabled={loading}
              onClick={() => void handleApplyAll()}
            >
              <Check className="w-3.5 h-3.5 mr-1" />
              Apply All
            </Button>
            <Button
              variant="outline"
              className="flex-1 text-xs h-8 border-[#26262B] hover:bg-[#1C1C22]"
              disabled={loading}
              onClick={() => void handleDismissAll()}
            >
              Dismiss
            </Button>
          </div>
        )}
        
        {checkpoints.length > 0 && (
          <button
            type="button"
            className="text-[11px] text-[#9B6AF1] hover:underline text-center py-1 mt-1 transition-all"
            disabled={loading}
            onClick={() => void handleRollback()}
          >
            Rollback to last checkpoint ({checkpoints[0].id.substring(0, 8)})
          </button>
        )}
      </div>
    </div>
  );
}

function ErrorBlock({ error, compact = false }: { error: string; compact?: boolean }) {
  const body = (
    <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs leading-relaxed text-destructive">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
    </div>
  );
  if (compact) return body;
  return body;
}

function WorkflowCard({
  icon: Icon,
  title,
  badge,
  tone = "default",
  children,
}: {
  icon: typeof Sparkles;
  title: string;
  badge?: string;
  tone?: "default" | "warning" | "accent";
  children: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "w-full overflow-hidden rounded-md border-border/70 bg-card/55 shadow-none",
        tone === "warning" && "border-amber-500/45 bg-amber-500/[0.04]",
        tone === "accent" && "border-primary/35 bg-primary/[0.04]",
      )}
    >
      <div className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-accent text-foreground",
              tone === "warning" && "bg-amber-500/15 text-amber-300",
              tone === "accent" && "bg-primary/15 text-primary",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </span>
          <span className="truncate text-xs font-semibold text-muted-foreground">{title}</span>
        </div>
        {badge ? (
          <Badge variant={tone === "warning" ? "warning" : "secondary"} className="h-5 shrink-0 capitalize">
            {badge}
          </Badge>
        ) : null}
      </div>
      <div className="p-3">{children}</div>
    </Card>
  );
}

function InlineList({
  title,
  values,
  monospace,
}: {
  title: string;
  values: string[];
  monospace?: boolean;
}) {
  const cleaned = values.map((value) => value.trim()).filter(Boolean);
  if (!cleaned.length) return null;
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {cleaned.slice(0, 12).map((value) => (
          <span
            key={value}
            title={value}
            className={cn(
              "max-w-full truncate rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground",
              monospace && "font-mono",
            )}
          >
            {value}
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryLine({
  label,
  value,
  monospace,
  tone,
}: {
  label: string;
  value: string;
  monospace?: boolean;
  tone?: "error";
}) {
  return (
    <div className="mt-2 grid gap-1">
      <div className="text-[10px] font-semibold uppercase text-muted-foreground">{label}</div>
      <div
        className={cn(
          "min-w-0 overflow-hidden text-ellipsis rounded-md bg-muted/50 px-2 py-1 text-[11px] leading-relaxed text-muted-foreground",
          monospace && "font-mono",
          tone === "error" && "bg-destructive/10 text-destructive",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function isReplitPlan(plan: Plan | ReplitPlan): plan is ReplitPlan {
  return "tasks" in plan;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function summarizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return clip(value, 360);
  try {
    return clip(JSON.stringify(value), 360);
  } catch {
    return clip(String(value), 360);
  }
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, item) => (typeof item === "bigint" ? item.toString() : item),
      2,
    );
  } catch (err) {
    return `Unable to render payload: ${(err as Error).message}`;
  }
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function countBySeverity(findings: CodeReviewFinding[]): Array<[FindingSeverity, number]> {
  const counts = new Map<FindingSeverity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return Array.from(counts.entries());
}

function formatTime(value: string): string {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(t));
}
