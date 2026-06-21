import type { AgentEvents } from "@zoc-studio/shared-types";
import type { AgentEvent, StreamErrorEvent } from "./useAgentStream";
import { parseUnifiedDiff } from "@/lib/diff-utils";

export type PlanStatus = "pending" | "active" | "done";
export type RunTraceStatus = "running" | "awaiting_review" | "done" | "failed" | "paused";
export type ActivityKind = "thinking" | "read-files" | "edit-file" | "command" | "intent" | "error";

export interface TracePlanItem {
  id: string;
  label: string;
  status: PlanStatus;
}

export interface TraceActivity {
  id: string;
  kind: ActivityKind;
  label: string;
  meta?: string;
  detail?: string;
  path?: string;
  diff?: string;
  adds?: number;
  dels?: number;
  status?: string;
  output?: string;
  files?: AgentEvents.ReadFileRef[];
}

export interface TraceReviewFile {
  path: string;
  diff: string;
  adds: number;
  dels: number;
  summary?: string | null;
}

export interface TraceReview {
  files: TraceReviewFile[];
  validation: AgentEvents.ReviewValidation;
  checkpointId?: string | null;
}

export interface TraceTestResults {
  status: "pass" | "fail";
  command: string;
  source: string;
  passed: number;
  failed: number;
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

export interface RunTrace {
  runId: string;
  startedSeq: number;
  lastSeq: number;
  status: RunTraceStatus;
  stage: string;
  prompt?: string;
  checkpointId?: string | null;
  planItems: TracePlanItem[];
  activities: TraceActivity[];
  review?: TraceReview;
  testResults?: TraceTestResults;
  summary?: string;
  doneReason?: string | null;
  error?: string;
}

type TraceableEvent = AgentEvent | (StreamErrorEvent & { runId?: string });

export function buildRunTraces(events: readonly TraceableEvent[]): RunTrace[] {
  const traces = new Map<string, RunTrace>();
  for (const event of events) {
    const type = (event as { type?: unknown }).type;
    if (type === "token" || type === "budget") continue;
    const runId = event.runId;
    if (!runId) continue;
    const trace = ensureTrace(traces, runId, event.seq);
    trace.lastSeq = Math.max(trace.lastSeq, event.seq);

    switch (type) {
      case "intent":
        foldIntent(trace, event as AgentEvents.IntentEvent);
        break;
      case "thinking":
        foldThinking(trace, event as AgentEvents.ThinkingEvent);
        break;
      case "plan":
        foldPlan(trace, event as AgentEvents.PlanEvent);
        break;
      case "plan-update":
        foldPlanUpdate(trace, event as AgentEvents.PlanUpdateEvent);
        break;
      case "read-files":
        foldReadFiles(trace, event as AgentEvents.ReadFilesEvent);
        break;
      case "edit-file":
        foldEditFile(trace, event as AgentEvents.EditFileEvent);
        break;
      case "command":
        foldCommand(trace, event as AgentEvents.CommandEvent);
        break;
      case "review":
        foldReview(trace, event as AgentEvents.ReviewEvent);
        break;
      case "test-results":
        foldTestResults(trace, event as AgentEvents.TestResultsEvent);
        break;
      case "summary":
        foldSummary(trace, event as AgentEvents.SummaryEvent);
        break;
      case "approval":
        trace.status = "paused";
        upsertActivity(trace, {
          id: `approval:${event.seq}`,
          kind: "intent",
          label: "Needs input",
          detail: (event as AgentEvents.ApprovalEvent).prompt,
          status: "paused",
        });
        break;
      case "done":
        trace.status = (event as AgentEvents.DoneEvent).ok ? "done" : "failed";
        trace.stage = "done";
        trace.doneReason = (event as AgentEvents.DoneEvent).reason ?? null;
        break;
      case "error":
        trace.status = "failed";
        trace.error = (event as StreamErrorEvent).message;
        upsertActivity(trace, {
          id: `error:${event.seq}`,
          kind: "error",
          label: "Run error",
          detail: (event as StreamErrorEvent).message,
          status: "failed",
        });
        break;
      case "checkpoint.created":
        trace.checkpointId = String((event as { checkpointId?: unknown }).checkpointId ?? "");
        break;
      case "todo_update":
        foldTodoUpdate(trace, event as unknown as LegacyTodoUpdateEvent);
        break;
      case "diff.ready":
        foldLegacyDiffReady(trace, event as unknown as LegacyDiffReadyEvent);
        break;
      default:
        break;
    }
  }
  return [...traces.values()].sort((a, b) => a.startedSeq - b.startedSeq);
}

function ensureTrace(map: Map<string, RunTrace>, runId: string, seq: number): RunTrace {
  const existing = map.get(runId);
  if (existing) return existing;
  const next: RunTrace = {
    runId,
    startedSeq: seq,
    lastSeq: seq,
    status: "running",
    stage: "starting",
    planItems: [],
    activities: [],
  };
  map.set(runId, next);
  return next;
}

function foldIntent(trace: RunTrace, event: AgentEvents.IntentEvent): void {
  trace.prompt = event.text;
  trace.stage = "analyze";
  upsertActivity(trace, {
    id: "intent",
    kind: "intent",
    label: "Intent",
    detail: event.text,
    meta: `${event.modelTier} · ${event.contextWindowTokens} tok`,
  });
}

function foldThinking(trace: RunTrace, event: AgentEvents.ThinkingEvent): void {
  const text = event.gist || event.text;
  const stage = stageFromText(text);
  if (stage) trace.stage = stage;
  upsertActivity(trace, {
    id: `thinking:${event.seq}`,
    kind: "thinking",
    label: stage ? stageLabel(stage) : "Operational context",
    detail: text,
    meta: event.truncated ? "truncated" : undefined,
  });
}

function foldPlan(trace: RunTrace, event: AgentEvents.PlanEvent): void {
  trace.checkpointId = event.checkpointId ?? trace.checkpointId;
  trace.planItems = event.items.map((item) => ({ ...item }));
  trace.stage = activePlanItem(trace.planItems)?.id ?? trace.stage;
}

function foldPlanUpdate(trace: RunTrace, event: AgentEvents.PlanUpdateEvent): void {
  trace.planItems = trace.planItems.map((item) =>
    item.id === event.id ? { ...item, status: event.status } : item,
  );
  const active = activePlanItem(trace.planItems);
  if (active) trace.stage = active.id;
}

function foldReadFiles(trace: RunTrace, event: AgentEvents.ReadFilesEvent): void {
  upsertActivity(trace, {
    id: `read:${event.seq}`,
    kind: "read-files",
    label: `${event.files.length} file${event.files.length === 1 ? "" : "s"} read`,
    files: event.files,
    meta: "read",
  });
}

function foldEditFile(trace: RunTrace, event: AgentEvents.EditFileEvent): void {
  const parsed = parseUnifiedDiff(event.diff);
  const adds = event.adds ?? parsed.adds;
  const dels = event.dels ?? parsed.dels;
  upsertActivity(trace, {
    id: `edit:${event.path}`,
    kind: "edit-file",
    label: event.path,
    path: event.path,
    diff: event.diff,
    adds,
    dels,
    status: event.status ?? "done",
    meta: `+${adds} -${dels}`,
  });
}

function foldCommand(trace: RunTrace, event: AgentEvents.CommandEvent): void {
  const id = `command:${event.commandId ?? event.command}`;
  const output = [existingActivity(trace, id)?.output, event.outputDelta]
    .filter(Boolean)
    .join("");
  upsertActivity(trace, {
    id,
    kind: "command",
    label: event.command,
    status: event.status ?? statusFromExit(event.exitCode),
    meta: event.exitCode == null ? event.status ?? "running" : `exit ${event.exitCode}`,
    output: event.outputTail ?? output,
    detail: event.errorTag ?? undefined,
  });
}

function foldReview(trace: RunTrace, event: AgentEvents.ReviewEvent): void {
  trace.status = "awaiting_review";
  trace.stage = "review";
  trace.checkpointId = event.checkpointId ?? trace.checkpointId;
  trace.review = {
    files: event.files.map((file) => {
      const parsed = parseUnifiedDiff(file.diff);
      return {
        ...file,
        adds: file.adds ?? parsed.adds,
        dels: file.dels ?? parsed.dels,
      };
    }),
    validation: event.validation,
    checkpointId: event.checkpointId,
  };
}

function foldTestResults(trace: RunTrace, event: AgentEvents.TestResultsEvent): void {
  trace.stage = "validate";
  trace.testResults = {
    status: event.status,
    command: event.command,
    source: event.source,
    passed: event.passed,
    failed: event.failed,
    exitCode: event.exitCode,
    output: event.outputTail ?? "",
    durationMs: event.durationMs ?? 0,
    timedOut: event.timedOut ?? false,
  };
}

function foldSummary(trace: RunTrace, event: AgentEvents.SummaryEvent): void {
  const text = event.text.trim();
  if (!text || text.toLowerCase() === "summary") return;
  trace.summary = text;
  trace.stage = "summary";
}

function foldTodoUpdate(trace: RunTrace, event: LegacyTodoUpdateEvent): void {
  const items = Array.isArray(event.items) ? event.items : [];
  trace.planItems = items
    .filter((item): item is TracePlanItem => Boolean(item?.id && item?.label && item?.status))
    .map((item) => ({ id: item.id, label: item.label, status: item.status }));
}

function foldLegacyDiffReady(trace: RunTrace, event: LegacyDiffReadyEvent): void {
  if (trace.review) return;
  const files = Array.isArray(event.files) ? event.files : [];
  trace.review = {
    files: files.map((file) => {
      const parsed = parseUnifiedDiff(file.diff ?? "");
      return {
        path: file.path,
        diff: file.diff ?? "",
        adds: file.adds ?? parsed.adds,
        dels: file.dels ?? parsed.dels,
        summary: file.summary ?? null,
      };
    }),
    validation: {
      typecheck: { status: "skipped" },
      build: { status: "skipped" },
      tests: { status: "skipped" },
    },
    checkpointId: event.checkpointId ?? null,
  };
}

function upsertActivity(trace: RunTrace, activity: TraceActivity): void {
  const index = trace.activities.findIndex((row) => row.id === activity.id);
  if (index === -1) {
    trace.activities.push(activity);
    return;
  }
  trace.activities[index] = { ...trace.activities[index], ...activity };
}

function existingActivity(trace: RunTrace, id: string): TraceActivity | undefined {
  return trace.activities.find((activity) => activity.id === id);
}

function activePlanItem(items: TracePlanItem[]): TracePlanItem | undefined {
  return items.find((item) => item.status === "active");
}

function statusFromExit(exitCode: number | null | undefined): string {
  if (exitCode == null) return "running";
  return exitCode === 0 ? "pass" : "fail";
}

function stageFromText(text: string): string | null {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("plan_edits")) return "plan";
  if (normalized.includes("apply_edits")) return "apply";
  if (normalized.includes("run_checks")) return "validate";
  if (normalized.includes("read_files")) return "read";
  if (normalized.includes("map_files")) return "map";
  if (normalized.includes("analyze")) return "analyze";
  return null;
}

function stageLabel(stage: string): string {
  return stage.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

interface LegacyTodoUpdateEvent {
  type: "todo_update";
  seq: number;
  runId: string;
  items?: TracePlanItem[];
}

interface LegacyDiffReadyEvent {
  type: "diff.ready";
  seq: number;
  runId: string;
  checkpointId?: string | null;
  files?: Array<{
    path: string;
    diff?: string;
    adds?: number;
    dels?: number;
    summary?: string | null;
  }>;
}
