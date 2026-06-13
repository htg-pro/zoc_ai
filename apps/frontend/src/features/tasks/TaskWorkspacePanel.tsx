import { useMemo, type ReactNode } from "react";
import {
  CheckCircle2,
  ClipboardList,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  X,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { TaskBoard, StatusBadge } from "./TaskBoard";
import type { ReplitCheckpoint, ReplitTask, ReplitTaskLog } from "@llama-studio/shared-types";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

const EMPTY_TASK_LOGS: ReplitTaskLog[] = [];

function countValidationOutcomes(output: string | null | undefined): { passed: number; failed: number } {
  if (!output) return { passed: 0, failed: 0 };
  let passed = 0;
  let failed = 0;
  for (const line of output.split("\n")) {
    if (line.includes("[PASS]")) passed += 1;
    else if (line.includes("[FAIL]")) failed += 1;
  }
  return { passed, failed };
}

function formatWorkflowError(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return trimmed;
  if (/^(http\s*)?409/i.test(trimmed) || /\b409\b/.test(trimmed)) {
    return `Workflow state conflict — ${trimmed}`;
  }
  return trimmed;
}

export function TaskWorkspacePanel() {
  const tasks = useApp((s) => s.replitTasks);
  const selectedId = useApp((s) => s.selectedReplitTaskId);
  const logs = useApp((s) =>
    s.selectedReplitTaskId ? s.replitTaskLogs[s.selectedReplitTaskId] ?? EMPTY_TASK_LOGS : EMPTY_TASK_LOGS,
  );
  const checkpoints = useApp((s) => s.replitCheckpoints);
  const error = useApp((s) => s.replitWorkflowError);
  const draftPlan = useApp((s) => s.replitPlans.find((p) => p.status === "draft") ?? null);
  const activePlanTitle = useApp((s) => {
    const approved = s.replitPlans.find((p) => p.status === "approved");
    return (approved ?? s.replitPlans.find((p) => p.status === "draft"))?.title ?? null;
  });
  const queueTask = useApp((s) => s.queueReplitTask);
  const startTask = useApp((s) => s.startReplitTask);
  const markReady = useApp((s) => s.markReplitTaskReady);
  const applyTask = useApp((s) => s.applyReplitTask);
  const dismissTask = useApp((s) => s.dismissReplitTask);
  const cancelTask = useApp((s) => s.cancelReplitTask);
  const rollback = useApp((s) => s.rollbackReplitCheckpoint);
  const loadWorkflow = useApp((s) => s.loadReplitWorkflow);
  const clearError = useApp((s) => s.clearReplitWorkflowError);
  const approvePlan = useApp((s) => s.approveReplitPlan);
  const setInput = useApp((s) => s.setInput);
  const workflowLoading = useApp((s) => s.replitWorkflowLoading);

  const selected = useMemo(() => tasks.find((task) => task.id === selectedId) ?? null, [tasks, selectedId]);
  const validationCounts = useMemo(() => countValidationOutcomes(selected?.test_output), [selected?.test_output]);
  const runActive = tasks.some((task) => task.status === "active");

  const startPlanDraft = () => {
    setInput("/plan ");
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {/* Status strip — always visible */}
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <ClipboardList className="h-3.5 w-3.5 shrink-0 text-primary" />
        <span className="shrink-0 text-xs font-semibold">Task workspace</span>
        <Badge variant={runActive ? "warning" : "muted"} className="shrink-0">
          {runActive ? <RotateCcw className="h-2.5 w-2.5 animate-spin" /> : null}
          {runActive ? "Running" : "Idle"}
        </Badge>
        <span
          className="hidden min-w-0 flex-1 truncate text-[11px] text-muted-foreground sm:block"
          title={activePlanTitle ?? undefined}
        >
          {activePlanTitle ?? "No active plan"}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-xs"
            disabled={workflowLoading}
            onClick={() => void loadWorkflow()}
          >
            <RotateCcw className={cn("mr-1 h-3 w-3", workflowLoading && "animate-spin")} /> Refresh
          </Button>
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={startPlanDraft}>
            <Plus className="mr-1 h-3 w-3" /> Create task
          </Button>
        </div>
      </div>

      {error && (
        <div className="shrink-0 px-3 pt-2">
          <div className="inline-flex items-center gap-1 rounded bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
            {formatWorkflowError(error)}
            <button
              type="button"
              aria-label="Dismiss workflow error"
              onClick={() => clearError()}
              className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded hover:bg-destructive/20"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        </div>
      )}

      {tasks.length === 0 ? (
        <TasksEmptyState
          draftPlan={Boolean(draftPlan)}
          workflowLoading={workflowLoading}
          checkpoints={checkpoints}
          onCreatePlan={startPlanDraft}
          onApprovePlan={() => draftPlan && void approvePlan(draftPlan.id)}
          onOpenComposer={startPlanDraft}
          onRollback={(id) => void rollback(id)}
        />
      ) : (
        <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(180px,1fr)_minmax(240px,1fr)] overflow-hidden xl:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)] xl:grid-rows-none">
          <TaskBoard />
          <ScrollArea className="min-w-0 border-t border-border xl:border-l xl:border-t-0">
            <div className="space-y-3 p-3">
              {selected ? (
                <>
                  <TaskDetailHeader
                    task={selected}
                    loading={workflowLoading}
                    onQueue={() => void queueTask(selected.id)}
                    onStart={() => void startTask(selected.id)}
                    onReady={() => void markReady(selected.id)}
                    onApply={() => void applyTask(selected.id)}
                    onDismiss={() => void dismissTask(selected.id)}
                    onCancel={() => void cancelTask(selected.id)}
                  />
                  <Panel title="Done looks like">
                    <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
                      {selected.done_looks_like.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  </Panel>
                  <Panel title="Likely files">
                    <div className="flex flex-wrap gap-1">
                      {selected.files_likely_changed.map((file) => (
                        <Badge key={file} variant="secondary" className="font-mono text-[10px]">
                          {file}
                        </Badge>
                      ))}
                    </div>
                  </Panel>
                  <Panel title="Task logs">
                    <div className="space-y-1 font-mono text-[11px] text-muted-foreground">
                      {logs.length ? logs.map((log) => <div key={log.id}>[{log.level}] {log.message}</div>) : <div>No logs yet.</div>}
                    </div>
                  </Panel>
                  <Panel title="Diff review">
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] text-muted-foreground">
                      {selected.diff || "No diff captured yet. Ready stays blocked until the backend produces a real diff."}
                    </pre>
                  </Panel>
                  <Panel
                    title="Validation"
                    right={
                      selected.test_output ? (
                        <div className="flex items-center gap-1">
                          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-600">
                            ✓ {validationCounts.passed}
                          </span>
                          {validationCounts.failed > 0 && (
                            <span className="inline-flex items-center gap-1 rounded bg-destructive/15 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                              ✗ {validationCounts.failed}
                            </span>
                          )}
                          {typeof selected.validation_attempts === "number" && selected.validation_attempts > 0 && (
                            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                              attempt {selected.validation_attempts}
                            </span>
                          )}
                        </div>
                      ) : null
                    }
                  >
                    <pre className="whitespace-pre-wrap rounded bg-muted p-2 text-[11px] text-muted-foreground">
                      {selected.test_output || selected.test_plan.map((item) => `- ${item}`).join("\n") || "No validation plan."}
                    </pre>
                  </Panel>
                </>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-4 text-xs text-muted-foreground">
                  Select a task card to see its logs, diff, tests and apply controls.
                </div>
              )}
              <CheckpointsPanel checkpoints={checkpoints} onRollback={(id) => void rollback(id)} />
            </div>
          </ScrollArea>
        </div>
      )}
    </div>
  );
}

function TasksEmptyState({
  draftPlan,
  workflowLoading,
  checkpoints,
  onCreatePlan,
  onApprovePlan,
  onOpenComposer,
  onRollback,
}: {
  draftPlan: boolean;
  workflowLoading: boolean;
  checkpoints: ReplitCheckpoint[];
  onCreatePlan: () => void;
  onApprovePlan: () => void;
  onOpenComposer: () => void;
  onRollback: (id: string) => void;
}) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="space-y-3 p-3">
        <div className="rounded-lg border border-dashed border-border bg-card/30 p-4 text-center">
          <div className="text-sm font-semibold">No Replit-style tasks yet</div>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">
            Create a plan and approve it to generate isolated task cards with logs, diffs, tests and
            apply controls.
          </p>
        </div>

        <div className="grid gap-3">
          <GuidanceCard
            step={1}
            icon={ClipboardList}
            title="Create plan"
            description="Ask the agent to create a plan first."
            footer={
              <div className="grid w-full grid-cols-2 gap-2">
                <Button size="sm" variant="ghost" onClick={onOpenComposer}>
                  Use composer
                </Button>
                <Button size="sm" onClick={onCreatePlan}>
                  Create plan
                </Button>
              </div>
            }
          />
          <GuidanceCard
            step={2}
            icon={ShieldCheck}
            title="Approve plan"
            description="Approved plans generate task cards."
            footer={
              <Button
                size="sm"
                className="w-full"
                disabled={!draftPlan || workflowLoading}
                onClick={onApprovePlan}
              >
                {workflowLoading ? (
                  <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                ) : (
                  <ShieldCheck className="mr-1 h-3 w-3" />
                )}
                Approve plan
              </Button>
            }
          />
          <GuidanceCard
            step={3}
            icon={Play}
            title="Run tasks"
            description="Tasks show logs, diffs, tests and apply controls."
            footer={
              <Button size="sm" className="w-full" disabled>
                <Play className="mr-1 h-3 w-3" /> Run tasks
              </Button>
            }
          />
        </div>

        <div className="grid gap-3 [@media(min-width:560px)]:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <PreviewPane title="Task board" rows={["Queued", "Active", "Ready", "Failed", "Done"]} />
          <PreviewPane title="Task detail" rows={["Summary", "Logs", "Files changed", "Diff", "Tests"]} />
        </div>

        <CheckpointsPanel checkpoints={checkpoints} onRollback={onRollback} />
      </div>
    </ScrollArea>
  );
}

function GuidanceCard({
  step,
  icon: Icon,
  title,
  description,
  footer,
}: {
  step: number;
  icon: typeof ClipboardList;
  title: string;
  description: string;
  footer: ReactNode;
}) {
  return (
    <Card className="bg-card/40">
      <div className="flex items-start gap-3 p-3">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-semibold text-primary">
          {step}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate text-sm font-semibold">{title}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          <div className="mt-2">{footer}</div>
        </div>
      </div>
    </Card>
  );
}

function PreviewPane({ title, rows }: { title: string; rows: string[] }) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <GitBranch className="h-3.5 w-3.5" /> {title}
      </div>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row}
            className="flex items-center justify-between rounded border border-dashed border-border/70 px-2 py-1 text-[11px] text-muted-foreground"
          >
            <span>{row}</span>
            <span className="h-1.5 w-10 rounded-full bg-muted" />
          </div>
        ))}
      </div>
    </section>
  );
}

function CheckpointsPanel({
  checkpoints,
  onRollback,
}: {
  checkpoints: ReplitCheckpoint[];
  onRollback: (id: string) => void;
}) {
  return (
    <Panel title="Checkpoints">
      <div className="space-y-2">
        {checkpoints.length ? (
          checkpoints.map((checkpoint) => (
            <div
              key={checkpoint.id}
              className="flex items-center justify-between gap-2 rounded border border-border p-2 text-xs"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{checkpoint.label}</div>
                <div className="text-[11px] text-muted-foreground">
                  {checkpoint.files.length} file(s) · {new Date(checkpoint.created_at).toLocaleString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 px-2 text-[11px]"
                onClick={() => onRollback(checkpoint.id)}
              >
                Rollback
              </Button>
            </div>
          ))
        ) : (
          <div className="text-xs text-muted-foreground">
            No checkpoints yet. Applying a task creates one.
          </div>
        )}
      </div>
    </Panel>
  );
}

function TaskDetailHeader({
  task,
  loading,
  onQueue,
  onStart,
  onReady,
  onApply,
  onDismiss,
  onCancel,
}: {
  task: ReplitTask;
  loading: boolean;
  onQueue: () => void;
  onStart: () => void;
  onReady: () => void;
  onApply: () => void;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-card/60 p-3">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold" title={task.title}>{task.title}</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{task.summary}</p>
        </div>
        <StatusBadge status={task.status} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {task.status === "draft" && (
          <Button size="sm" variant="secondary" className="h-7 px-2 text-xs" disabled={loading} onClick={onQueue}>
            Queue task
          </Button>
        )}
        {(task.status === "draft" || task.status === "queued" || task.status === "failed") && (
          <Button size="sm" className="h-7 px-2 text-xs" disabled={loading} onClick={onStart}>
            <Play className="mr-1 h-3 w-3" /> Start isolated task
          </Button>
        )}
        {task.status === "failed" && task.diff && task.test_output?.includes("NO ERROR") && (
          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={loading} onClick={onReady}>
            <ShieldCheck className="mr-1 h-3 w-3" /> Mark ready
          </Button>
        )}
        {task.status === "ready" && (
          <>
            <Button size="sm" className="h-7 px-2 text-xs" disabled={loading} onClick={onApply}>
              <CheckCircle2 className="mr-1 h-3 w-3" /> Apply to main
            </Button>
            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={loading} onClick={onDismiss}>
              <XCircle className="mr-1 h-3 w-3" /> Dismiss
            </Button>
          </>
        )}
        {task.status === "active" && (
          <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" disabled={loading} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function Panel({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between gap-2 text-xs font-semibold">
        <div className="flex items-center gap-1.5">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" /> {title}
        </div>
        {right ?? null}
      </div>
      {children}
    </section>
  );
}
