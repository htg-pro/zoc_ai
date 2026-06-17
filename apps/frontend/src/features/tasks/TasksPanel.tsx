import { useEffect, useMemo } from "react";
import { CheckCircle2, FlaskConical, Hammer, Loader2, Play, RefreshCw, Wrench, XCircle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useApp } from "@/lib/store";
import { isTauri } from "@/lib/tauri-bridge";
import type { Task, TaskGroup } from "@/lib/tasks";
import { cn } from "@/lib/utils";

const GROUP_ICON: Record<TaskGroup, typeof Wrench> = {
  build: Hammer,
  test: FlaskConical,
  none: Wrench,
};

export function TasksPanel() {
  const tasks = useApp((s) => s.tasks);
  const taskRuns = useApp((s) => s.taskRuns);
  const discoverTasks = useApp((s) => s.discoverTasks);
  const runTask = useApp((s) => s.runTask);

  useEffect(() => {
    if (tasks.length === 0) void discoverTasks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tests first (this doubles as a lightweight Test Explorer), then build, then the rest.
  const sorted = useMemo(() => {
    const rank = (g: TaskGroup) => (g === "test" ? 0 : g === "build" ? 1 : 2);
    return [...tasks].sort((a, b) => rank(a.group) - rank(b.group) || a.label.localeCompare(b.label));
  }, [tasks]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between border-b border-border px-2 py-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {tasks.length} task{tasks.length === 1 ? "" : "s"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[10px]"
          onClick={() => void discoverTasks()}
        >
          <RefreshCw className="mr-1 h-3 w-3" /> Rescan
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {tasks.length === 0 ? (
          <div className="px-3 py-10 text-center text-xs text-muted-foreground">
            {isTauri()
              ? "No tasks found. Add a .vscode/tasks.json, .zoc/tasks.json, npm scripts, a Makefile, or Cargo.toml."
              : "Task discovery runs in the desktop app."}
          </div>
        ) : (
          <ul className="py-1">
            {sorted.map((task) => (
              <TaskRow key={task.id} task={task} status={taskRuns[task.id]} onRun={() => void runTask(task.id)} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function TaskRow({
  task,
  status,
  onRun,
}: {
  task: Task;
  status: "running" | "passed" | "failed" | undefined;
  onRun: () => void;
}) {
  const Icon = GROUP_ICON[task.group];
  return (
    <li className="group flex items-center gap-2 px-2 py-1 hover:bg-accent/40">
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs text-foreground">{task.label}</div>
        <div className="truncate font-mono text-[10px] text-muted-foreground">
          {task.command} {task.args.join(" ")}
        </div>
      </div>
      {task.group !== "none" && (
        <Badge variant="muted" className="shrink-0 uppercase">
          {task.group}
        </Badge>
      )}
      <StatusIcon status={status} />
      <Button
        size="icon"
        variant="ghost"
        className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
        title={`Run ${task.label}`}
        aria-label={`Run ${task.label}`}
        disabled={status === "running"}
        onClick={onRun}
      >
        <Play className="h-3.5 w-3.5" />
      </Button>
    </li>
  );
}

function StatusIcon({ status }: { status: "running" | "passed" | "failed" | undefined }) {
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />;
  if (status === "passed") return <CheckCircle2 className={cn("h-3.5 w-3.5 shrink-0 text-emerald-500")} />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 shrink-0 text-destructive" />;
  return <span className="w-3.5 shrink-0" />;
}
