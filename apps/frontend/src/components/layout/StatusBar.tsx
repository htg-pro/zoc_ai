import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import {
  AlertCircle,
  Cpu,
  Database,
  GitBranch,
  Loader2,
  Sparkles,
  TerminalSquare,
  TriangleAlert,
} from "lucide-react";
import { useApp } from "@/lib/store";
import { countBySeverity } from "@/lib/problem-matchers";
import {
  getCursorPosition,
  subscribeCursor,
  type CursorPosition,
} from "@/lib/editor-actions";
import {
  agentStateLabel,
  diagnosticsLabel,
  formatCursor,
  languageLabel,
  modelLabel,
} from "@/lib/status-bar";
import { cn } from "@/lib/utils";

function useCursor(): CursorPosition | null {
  const [pos, setPos] = useState<CursorPosition | null>(getCursorPosition());
  useEffect(() => subscribeCursor(() => setPos(getCursorPosition())), []);
  return pos;
}

/**
 * Real status bar (develop.md Phase 14). A single row of live indicators that
 * double as navigation: Git branch, dirty count, diagnostics (→ Problems),
 * agent state (→ Agent panel), indexer state, terminals, background tasks,
 * active model, language mode, line/column, encoding, and a sidecar indicator.
 */
export function StatusBar() {
  const git = useApp((s) => s.git);
  const diagnostics = useApp((s) => s.diagnostics);
  const streaming = useApp((s) => s.streaming);
  const isRunning = useApp((s) => s.isRunning);
  const agentMode = useApp((s) => s.agentMode);
  const terminals = useApp((s) => s.terminals);
  const taskRuns = useApp((s) => s.taskRuns);
  const selectedModel = useApp((s) => s.selectedModel);
  const llamaCppStatus = useApp((s) => s.llamaCppStatus);
  const indexStatus = useApp((s) => s.indexStatus);
  const liveMode = useApp((s) => s.liveMode);
  const activeFile = useApp((s) => s.activeFile);
  const openFiles = useApp((s) => s.openFiles);
  const loadIndexStatus = useApp((s) => s.loadIndexStatus);

  const setActivity = useApp((s) => s.setActivity);
  const toggleSide = useApp((s) => s.toggleSide);
  const setBottomTab = useApp((s) => s.setBottomTab);
  const toggleBottom = useApp((s) => s.toggleBottom);
  const toggleRight = useApp((s) => s.toggleRight);
  const sidePanelOpen = useApp((s) => s.layout.sidePanelOpen);
  const bottomDockOpen = useApp((s) => s.layout.bottomDockOpen);
  const rightPanelOpen = useApp((s) => s.layout.rightPanelOpen);

  const cursor = useCursor();

  useEffect(() => {
    if (liveMode) void loadIndexStatus();
  }, [liveMode, loadIndexStatus]);

  const file = openFiles.find((f) => f.path === activeFile) ?? null;
  const { errors, warnings } = countBySeverity(Object.values(diagnostics).flat());
  const agent = agentStateLabel({ streaming, isRunning, agentMode });
  const dirtyCount = openFiles.filter((f) => f.dirty).length;
  const gitDirty = git
    ? git.staged.length + git.unstaged.length + git.untracked.length + git.conflicts.length
    : 0;
  const runningTasks = Object.values(taskRuns).filter((s) => s === "running").length;
  const modelRunning = !!llamaCppStatus?.running;

  const openProblems = () => {
    setBottomTab("problems");
    if (!bottomDockOpen) toggleBottom();
  };
  const openAgent = () => {
    if (!rightPanelOpen) toggleRight();
  };
  const openScm = () => {
    setActivity("scm");
    if (!sidePanelOpen) toggleSide();
  };
  const openIndexer = () => {
    setActivity("indexer");
    if (!sidePanelOpen) toggleSide();
  };
  const openTerminal = () => {
    setBottomTab("terminal");
    if (!bottomDockOpen) toggleBottom();
  };

  return (
    <footer className="flex h-[22px] shrink-0 items-center justify-between border-t border-border bg-[hsl(var(--surface))] px-1 text-[11px] text-muted-foreground select-none">
      {/* Left cluster: repo / agent / diagnostics / index */}
      <div className="flex min-w-0 items-center">
        <Item onClick={openScm} title={git?.is_repo ? "Open Source Control" : "Not a Git repository"}>
          <GitBranch className="h-3 w-3" />
          <span className="font-mono">{git?.is_repo ? git.branch ?? "(detached)" : "—"}</span>
          {gitDirty > 0 && <span className="text-warning">{gitDirty}*</span>}
        </Item>

        <Item onClick={openAgent} title="Open Agent panel">
          {agent.tone === "busy" ? (
            <Loader2 className="h-3 w-3 animate-spin text-primary" />
          ) : (
            <Sparkles className={cn("h-3 w-3", agent.tone === "ask" ? "text-[var(--zoc-info)]" : "text-primary")} />
          )}
          <span>{agent.label}</span>
        </Item>

        <Item onClick={openProblems} title="Open Problems">
          <AlertCircle className={cn("h-3 w-3", errors > 0 && "text-destructive")} />
          <span className={cn(errors > 0 && "text-destructive")}>{errors}</span>
          <TriangleAlert className={cn("h-3 w-3", warnings > 0 && "text-warning")} />
          <span className={cn(warnings > 0 && "text-warning")}>{warnings}</span>
          <span className="sr-only">{diagnosticsLabel(errors, warnings)}</span>
        </Item>

        {liveMode && (
          <Item onClick={openIndexer} title="Open Indexer">
            <Database className="h-3 w-3" />
            <span>
              {indexStatus
                ? `${indexStatus.chunk_count.toLocaleString()} chunks${indexStatus.watching ? " · live" : ""}`
                : "Index"}
            </span>
          </Item>
        )}

        {runningTasks > 0 && (
          <Item onClick={() => { setBottomTab("tasks"); if (!bottomDockOpen) toggleBottom(); }} title="Background tasks">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>{runningTasks} task{runningTasks === 1 ? "" : "s"}</span>
          </Item>
        )}
      </div>

      {/* Right cluster: cursor / language / encoding / terminals / model / sidecar */}
      <div className="flex shrink-0 items-center">
        {dirtyCount > 0 && <Item title="Unsaved files"><span>{dirtyCount} unsaved</span></Item>}

        {file && (
          <>
            <Item title="Line and column">{formatCursor(cursor)}</Item>
            <Item title="File encoding">UTF-8</Item>
            <Item title="Language mode">{languageLabel(file)}</Item>
          </>
        )}

        <Item onClick={openTerminal} title="Terminals">
          <TerminalSquare className="h-3 w-3" />
          <span>{terminals.length}</span>
        </Item>

        <Item title={modelRunning ? "Local model loaded" : "Active model"}>
          <Cpu className={cn("h-3 w-3", modelRunning && "text-emerald-400")} />
          <span className="max-w-[160px] truncate">
            {modelLabel(selectedModel, llamaCppStatus?.loaded_model_id ?? null)}
          </span>
        </Item>

        <Item title={liveMode ? "Sidecar connected" : "Sidecar offline (browser preview)"}>
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              liveMode ? "bg-emerald-400" : "bg-muted-foreground/50",
            )}
          />
          <span>{liveMode ? "Connected" : "Offline"}</span>
        </Item>
      </div>
    </footer>
  );
}

function Item({
  children,
  onClick,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  title?: string;
}) {
  const className =
    "flex h-[22px] items-center gap-1 px-2 transition-colors hover:bg-accent/60";
  if (onClick) {
    return (
      <button type="button" onClick={onClick} title={title} className={className}>
        {children}
      </button>
    );
  }
  return (
    <span title={title} className={className}>
      {children}
    </span>
  );
}
