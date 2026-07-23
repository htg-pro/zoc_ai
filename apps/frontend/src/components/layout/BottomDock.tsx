import { Terminal as TerminalIcon, AlertTriangle, ListChecks, ScrollText, Megaphone, X, Pause, Play, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import { ProblemsPanel } from "@/features/problems/ProblemsPanel";
import { LogsPanel } from "@/features/problems/LogsPanel";
import { OutputPanel } from "@/features/problems/OutputPanel";
import { TasksPanel } from "@/features/tasks/TasksPanel";
import { CheckpointsPanel } from "@/features/agent/CheckpointsPanel";
import { useApp, type BottomTab } from "@/lib/store";
import { problemsBadge } from "@/lib/problems-badge";
import { cn } from "@/lib/utils";

const TABS: { key: BottomTab; label: string; icon: typeof TerminalIcon }[] = [
  { key: "terminal", label: "Terminal", icon: TerminalIcon },
  { key: "problems", label: "Problems", icon: AlertTriangle },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "output", label: "Output", icon: Megaphone },
  { key: "logs", label: "Logs", icon: ScrollText },
  { key: "checkpoints", label: "Checkpoints", icon: History },
];

export function BottomDock() {
  const tab = useApp((s) => s.bottomTab);
  const setTab = useApp((s) => s.setBottomTab);
  const toggle = useApp((s) => s.toggleBottom);
  // Agent-control toggle (R3.12): pause/resume the active run from the dock.
  const running = useApp((s) => s.streaming || s.isRunning);
  const paused = useApp((s) => s.agentPaused);
  const pauseAgent = useApp((s) => s.pauseAgent);
  const resumeAgent = useApp((s) => s.resumeAgent);
  // R4: the Problems tab pill is a pure function of the whole diagnostics store
  // (LSP per-URI entries + command-checker entries). Select the stable store
  // reference and derive the badge outside the selector so it recomputes only
  // when the diagnostics change (not on every render).
  const diagnostics = useApp((s) => s.diagnostics);
  const badge = problemsBadge(diagnostics);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-card/60 px-2">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Bottom dock">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
                {t.key === "problems" && badge.visible && (
                  <span
                    data-testid="problems-badge"
                    data-color={badge.color}
                    className={cn(
                      "ml-0.5 rounded-full px-1 font-mono text-[9px]",
                      badge.color === "error"
                        ? "bg-destructive/20 text-destructive"
                        : "bg-warning/20 text-warning",
                    )}
                  >
                    {badge.count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-1">
          {running && (
            <button
              type="button"
              aria-label={paused ? "Resume agent" : "Pause agent"}
              aria-pressed={paused}
              title={paused ? "Resume agent" : "Pause agent"}
              onClick={() => (paused ? resumeAgent() : pauseAgent())}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors",
                paused
                  ? "bg-warning/15 text-warning hover:bg-warning/25"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              {paused ? "Resume" : "Pause"} agent
            </button>
          )}
          <Button size="icon" variant="ghost" className="h-6 w-6" onClick={toggle} aria-label="Close dock">
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "terminal" && <TerminalPane />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "tasks" && <TasksPanel />}
        {tab === "output" && <OutputPanel />}
        {tab === "logs" && <LogsPanel />}
        {tab === "checkpoints" && <CheckpointsPanel />}
      </div>
    </div>
  );
}
