import { useEffect } from "react";
import { CheckCircle2, CircleDot, Clock3, FileDiff, GitBranch, Play, RotateCcw, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { ReplitTask, ReplitTaskStatus } from "@llama-studio/shared-types";

const COLUMNS: Array<{ status: ReplitTaskStatus; label: string; icon: typeof CircleDot }> = [
  { status: "draft", label: "Draft", icon: CircleDot },
  { status: "queued", label: "Queued", icon: Clock3 },
  { status: "active", label: "Active", icon: Play },
  { status: "ready", label: "Ready", icon: GitBranch },
  { status: "failed", label: "Failed", icon: XCircle },
  { status: "done", label: "Done", icon: CheckCircle2 },
  { status: "dismissed", label: "Dismissed", icon: XCircle },
  { status: "cancelled", label: "Cancelled", icon: XCircle },
];

export function TaskBoard({ compact = false }: { compact?: boolean }) {
  const tasks = useApp((s) => s.replitTasks);
  const selected = useApp((s) => s.selectedReplitTaskId);
  const selectTask = useApp((s) => s.selectReplitTask);
  const load = useApp((s) => s.loadReplitWorkflow);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => {
      if (useApp.getState().replitTasks.some((task) => task.status === "active")) {
        void useApp.getState().loadReplitWorkflow();
        const selectedId = useApp.getState().selectedReplitTaskId;
        if (selectedId) void useApp.getState().selectReplitTask(selectedId);
      }
    }, 2500);
    return () => window.clearInterval(id);
  }, [load]);

  if (!tasks.length) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        No Replit-style tasks yet. Create a plan from the Agent composer to generate task cards.
      </div>
    );
  }

  if (compact) {
    return (
      <ScrollArea className="h-full min-w-0">
        <div className="space-y-2 p-2">
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              active={selected === task.id}
              onClick={() => void selectTask(task.id)}
            />
          ))}
        </div>
      </ScrollArea>
    );
  }

  return (
    <ScrollArea className="h-full min-w-0">
      <div className="grid min-w-0 gap-3 p-3 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {COLUMNS.map((column) => {
          const Icon = column.icon;
          const columnTasks = tasks.filter((task) => task.status === column.status);
          return (
            <section key={column.status} className="min-h-40 min-w-0 rounded-lg border border-border bg-card/40">
              <div className="flex h-9 items-center justify-between border-b border-border px-2">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" />
                  {column.label}
                </div>
                <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                  {columnTasks.length}
                </Badge>
              </div>
              <div className="space-y-2 p-2">
                {columnTasks.length ? (
                  columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      active={selected === task.id}
                      onClick={() => void selectTask(task.id)}
                    />
                  ))
                ) : (
                  <div className="rounded border border-dashed border-border p-3 text-[11px] text-muted-foreground">
                    Empty
                  </div>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function changedFileCount(task: ReplitTask): number {
  if (task.diff && task.diff.trim()) {
    const files = task.diff.match(/^diff --git /gm) ?? task.diff.match(/^\+\+\+ /gm);
    if (files) return files.length;
  }
  return task.files_likely_changed.length;
}

function TaskProgress({ status }: { status: ReplitTaskStatus }) {
  if (status === "active") {
    return (
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
      </div>
    );
  }
  const pct =
    status === "done" || status === "ready" || status === "failed"
      ? 100
      : status === "queued"
        ? 35
        : 10;
  const color =
    status === "done" || status === "ready"
      ? "bg-emerald-500"
      : status === "failed"
        ? "bg-destructive"
        : "bg-muted-foreground/40";
  return (
    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
      <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
    </div>
  );
}

function TaskCard({ task, active, onClick }: { task: ReplitTask; active: boolean; onClick: () => void }) {
  const queue = useApp((s) => s.queueReplitTask);
  const start = useApp((s) => s.startReplitTask);
  const ready = useApp((s) => s.markReplitTaskReady);
  const apply = useApp((s) => s.applyReplitTask);
  const dismiss = useApp((s) => s.dismissReplitTask);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") onClick();
      }}
      className={cn(
        "w-full min-w-0 rounded-md border bg-background p-2 text-left shadow-sm transition-colors hover:border-primary/50",
        active ? "border-primary/70 ring-1 ring-primary/30" : "border-border",
      )}
    >
      <div className="mb-1 flex items-start justify-between gap-2">
        <div className="line-clamp-2 min-w-0 text-xs font-semibold">{task.title}</div>
        <StatusBadge status={task.status} />
      </div>
      <p className="line-clamp-3 text-[11px] leading-4 text-muted-foreground">{task.summary}</p>
      {task.error ? (
        <p className="mt-1 line-clamp-2 rounded bg-destructive/10 px-1.5 py-1 text-[10px] text-destructive">
          {task.error}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-1">
        {task.files_likely_changed.slice(0, 2).map((file) => (
          <span key={file} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" title={file}>
            {file}
          </span>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-1" onClick={(event) => event.stopPropagation()}>
        {task.status === "draft" && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void queue(task.id)}>
            Queue
          </Button>
        )}
        {(task.status === "draft" || task.status === "queued" || task.status === "failed") && (
          <Button size="sm" variant="secondary" className="h-6 px-2 text-[11px]" onClick={() => void start(task.id)}>
            <Play className="mr-1 h-3 w-3" /> Start
          </Button>
        )}
        {task.status === "failed" && task.diff && task.test_output?.includes("NO ERROR") && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" onClick={() => void ready(task.id)}>
            Ready
          </Button>
        )}
        {task.status === "ready" && (
          <>
            <Button size="sm" className="h-6 px-2 text-[11px]" onClick={() => void apply(task.id)}>
              <CheckCircle2 className="mr-1 h-3 w-3" /> Apply
            </Button>
            <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => void dismiss(task.id)}>
              <XCircle className="mr-1 h-3 w-3" /> Dismiss
            </Button>
          </>
        )}
      </div>
      <div className="mt-2 flex items-center justify-between text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <FileDiff className="h-3 w-3" />
          {changedFileCount(task)} file{changedFileCount(task) === 1 ? "" : "s"}
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 className="h-3 w-3" />
          {relativeTime(task.updated_at)}
        </span>
      </div>
      <TaskProgress status={task.status} />
    </div>
  );
}

export function StatusBadge({ status }: { status: ReplitTaskStatus }) {
  const variant = status === "ready" || status === "done" ? "default" : status === "failed" ? "destructive" : "secondary";
  return (
    <Badge variant={variant} className="shrink-0 px-1.5 py-0 text-[10px] capitalize">
      {status === "active" && <RotateCcw className="mr-1 h-2.5 w-2.5 animate-spin" />}
      {status}
    </Badge>
  );
}
