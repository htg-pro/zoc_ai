import { useEffect, useState } from "react";
import { Bug, ChevronDown, Hammer, Play, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useApp } from "@/lib/store";
import { buildRunTargets, defaultRunTarget, type RunTarget } from "@/lib/run-targets";
import { cn } from "@/lib/utils";

/**
 * Top Bar run selector (develop.md Run/Tasks/Debug UX). Replaces the old vague
 * "Run" button: a split control whose primary action runs the selected target
 * (a task or a debug config) and whose dropdown lists launch configs + tasks,
 * with a setup action when none are configured. It never silently means
 * "generate tests".
 */
export function RunSelector() {
  const launchConfigs = useApp((s) => s.launchConfigs);
  const tasks = useApp((s) => s.tasks);
  const discoverTasks = useApp((s) => s.discoverTasks);
  const loadLaunchConfigs = useApp((s) => s.loadLaunchConfigs);
  const runTask = useApp((s) => s.runTask);
  const setBottomTab = useApp((s) => s.setBottomTab);
  const toggleBottom = useApp((s) => s.toggleBottom);
  const bottomDockOpen = useApp((s) => s.layout.bottomDockOpen);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (tasks.length === 0) void discoverTasks();
    void loadLaunchConfigs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targets = buildRunTargets(launchConfigs, tasks);
  const selected = defaultRunTarget(targets, selectedId);

  const openTasksPanel = () => {
    setBottomTab("tasks");
    if (!bottomDockOpen) toggleBottom();
  };

  const run = (target: RunTarget) => {
    if (target.kind === "task") {
      void runTask(target.id);
      openTasksPanel();
      return;
    }
    // Debug adapter runtime is deferred (Phase 7); be honest rather than no-op.
    toast.message("Debug isn't wired yet", {
      description: `"${target.label}" needs the debug adapter runtime. Breakpoints and launch configs are ready.`,
    });
  };

  if (targets.length === 0) {
    return (
      <button
        type="button"
        onClick={() => {
          void discoverTasks();
          openTasksPanel();
        }}
        className="flex h-6 items-center gap-1.5 rounded-md border border-[hsl(var(--border-muted))] bg-card px-2.5 text-[11.5px] text-muted-foreground hover:bg-accent"
        title="No tasks or launch configs found — configure run targets"
      >
        <Settings2 className="h-3 w-3" />
        Configure Run
      </button>
    );
  }

  return (
    <div className="flex items-center">
      <button
        type="button"
        onClick={() => selected && run(selected)}
        disabled={!selected}
        className="flex h-6 items-center gap-1.5 rounded-l-md border border-r-0 border-[hsl(var(--border-muted))] bg-card px-2.5 text-[11.5px] text-foreground hover:bg-accent disabled:opacity-50"
        title={selected ? `Run ${selected.label}` : "No target selected"}
      >
        {selected?.kind === "debug" ? (
          <Bug className="h-3 w-3 text-[var(--zoc-info)]" />
        ) : (
          <Play className="h-3 w-3 text-emerald-400" />
        )}
        <span className="max-w-[160px] truncate">{selected?.label ?? "Run"}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose run target"
            className="flex h-6 items-center rounded-r-md border border-[hsl(var(--border-muted))] bg-card px-1 text-muted-foreground hover:bg-accent"
          >
            <ChevronDown className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {launchConfigs.length > 0 && (
            <>
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Debug Configurations
              </DropdownMenuLabel>
              {targets
                .filter((t) => t.kind === "debug")
                .map((t) => (
                  <TargetRow key={t.id} target={t} selected={selected?.id === t.id} onPick={() => { setSelectedId(t.id); run(t); }} />
                ))}
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Tasks
          </DropdownMenuLabel>
          {targets.filter((t) => t.kind === "task").length === 0 ? (
            <DropdownMenuItem disabled>No tasks discovered</DropdownMenuItem>
          ) : (
            targets
              .filter((t) => t.kind === "task")
              .map((t) => (
                <TargetRow key={t.id} target={t} selected={selected?.id === t.id} onPick={() => { setSelectedId(t.id); run(t); }} />
              ))
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openTasksPanel}>
            <Settings2 className="mr-2 h-3.5 w-3.5" /> Configure Tasks…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function TargetRow({
  target,
  selected,
  onPick,
}: {
  target: RunTarget;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <DropdownMenuItem onSelect={onPick} className="flex items-center gap-2">
      {target.kind === "debug" ? (
        <Bug className="h-3.5 w-3.5 text-[var(--zoc-info)]" />
      ) : target.detail === "make" || target.detail === "cargo" ? (
        <Hammer className="h-3.5 w-3.5 text-muted-foreground" />
      ) : (
        <Play className="h-3.5 w-3.5 text-emerald-400" />
      )}
      <span className={cn("truncate", selected && "font-medium text-foreground")}>{target.label}</span>
      <span className="ml-auto shrink-0 text-[10px] uppercase text-muted-foreground">{target.detail}</span>
    </DropdownMenuItem>
  );
}
