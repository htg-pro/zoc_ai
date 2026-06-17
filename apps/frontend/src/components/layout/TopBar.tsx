import { useEffect, useState } from "react";
import {
  Command as CommandIcon,
  GitBranch,
  Loader2,
  Minus,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RunSelector } from "./RunSelector";
import { useApp } from "@/lib/store";
import { closeWindow, isTauri, minimizeWindow, toggleMaximizeWindow } from "@/lib/tauri-bridge";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format-elapsed";

export function TopBar() {
  const togglePalette = useApp((s) => s.togglePalette);
  const toggleSide = useApp((s) => s.toggleSide);
  const toggleRight = useApp((s) => s.toggleRight);
  const toggleBottom = useApp((s) => s.toggleBottom);
  const session = useApp((s) => s.sessions.find((x) => x.id === s.activeSessionId));
  const isRunning = useApp((s) => s.isRunning);
  const streaming = useApp((s) => s.streaming);
  const rightPanelOpen = useApp((s) => s.layout.rightPanelOpen);
  const sidePanelOpen = useApp((s) => s.layout.sidePanelOpen);
  const bottomDockOpen = useApp((s) => s.layout.bottomDockOpen);
  const pendingPatchCount = useApp((s) => s.pendingPatches.length);
  const git = useApp((s) => s.git);
  const setActivity = useApp((s) => s.setActivity);
  const sidePanelOpenForGit = useApp((s) => s.layout.sidePanelOpen);
  const toggleSideForGit = useApp((s) => s.toggleSide);
  const gitDirtyCount = git
    ? git.staged.length + git.unstaged.length + git.untracked.length + git.conflicts.length
    : 0;
  const openScm = () => {
    setActivity("scm");
    if (!sidePanelOpenForGit) toggleSideForGit();
  };

  return (
    <header
      className="flex h-[38px] shrink-0 items-center justify-between border-b border-border bg-[hsl(var(--surface))] px-2"
      data-tauri-drag-region
    >
      <div className="flex min-w-0 items-center gap-2" data-tauri-drag-region>
        {/* Window controls */}
        {isTauri() && (
          <div className="flex items-center gap-0.5" data-tauri-drag-region={false}>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground"
              onClick={() => void minimizeWindow()}
              aria-label="Minimize window"
            >
              <Minus className="h-3 w-3" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground"
              onClick={() => void toggleMaximizeWindow()}
              aria-label="Maximize window"
            >
              <Square className="h-2.5 w-2.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={() => void closeWindow()}
              aria-label="Close window"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}

        {/* Divider */}
        {isTauri() && <div className="h-4 w-px bg-[hsl(var(--border-muted))]" />}

        {/* Logo */}
        <div className="flex shrink-0 items-center gap-2" data-tauri-drag-region>
          <div className="flex h-[18px] w-[18px] items-center justify-center rounded-[5px] bg-gradient-to-br from-[#9B6AF1] to-[#7C3AED] shadow-[0_2px_8px_rgba(124,58,237,0.35)]">
            <Sparkles className="h-[11px] w-[11px] text-white" />
          </div>
          <span className="text-[12.5px] font-medium text-foreground">Zoc AI</span>
        </div>

        {/* Divider */}
        <div className="h-4 w-px bg-[hsl(var(--border-muted))]" />

        {/* Workspace path + branch */}
        <div className="hidden min-w-0 items-center gap-2 md:flex" data-tauri-drag-region>
          <span
            className="max-w-[30vw] truncate font-mono text-[10.5px] text-muted-foreground"
            title={session?.workspace_root ?? undefined}
          >
            {session?.workspace_root ?? "-"}
          </span>
          <button
            type="button"
            onClick={openScm}
            className="flex h-5 shrink-0 items-center gap-1 rounded-md border border-[hsl(var(--border-muted))] bg-card px-1.5 hover:bg-accent"
            title={git?.is_repo ? "Open Source Control" : "Not a Git repository"}
          >
            <GitBranch className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {git?.is_repo ? git.branch ?? "(detached)" : "—"}
            </span>
            {gitDirtyCount > 0 && (
              <span className="ml-0.5 font-mono text-[10.5px] text-warning">{gitDirtyCount}</span>
            )}
          </button>
          {pendingPatchCount > 0 && (
            <div className="flex h-5 shrink-0 items-center gap-1.5 rounded-md border border-[hsl(var(--border-muted))] bg-card px-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              <span className="font-mono text-[10.5px] text-warning">+{pendingPatchCount}</span>
            </div>
          )}
        </div>
      </div>

      {/* Command palette */}
      <button
        type="button"
        onClick={() => togglePalette(true)}
        className="hidden h-6 w-[340px] items-center gap-2 rounded-md border border-[hsl(var(--border-muted))] bg-card px-2.5 text-[11px] text-muted-foreground/50 transition-colors hover:border-muted-foreground/30 md:flex"
        aria-label="Open command palette"
      >
        <CommandIcon className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">Search files, commands, settings…</span>
        <Kbd>⌘K</Kbd>
      </button>

      {/* Right controls */}
      <div className="flex shrink-0 items-center gap-1" data-tauri-drag-region={false}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className={cn("h-7 w-7", sidePanelOpen && "bg-primary/10 text-primary")} onClick={toggleSide} aria-label="Toggle side panel" aria-pressed={sidePanelOpen}>
              <PanelLeft className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle side panel</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button size="icon" variant="ghost" className={cn("h-7 w-7", bottomDockOpen && "bg-primary/10 text-primary")} onClick={toggleBottom} aria-label="Toggle bottom dock" aria-pressed={bottomDockOpen}>
              <PanelBottom className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle bottom dock</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className={cn(
                "h-7 w-7",
                rightPanelOpen && "bg-primary/10 text-primary",
              )}
              onClick={toggleRight}
              aria-label="Toggle agent panel"
              aria-pressed={rightPanelOpen}
            >
              <PanelRight className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Toggle agent panel</TooltipContent>
        </Tooltip>

        <div className="mx-1 h-4 w-px bg-[hsl(var(--border-muted))]" />

        {/* Running status or Run selector */}
        {isRunning || streaming ? (
          <RunningPill />
        ) : (
          <RunSelector />
        )}
      </div>
    </header>
  );
}

/* ── Running status pill ───────────────────────────────────────── */

function RunningPill() {
  const [elapsedMs, setElapsedMs] = useState(0);
  const cancelRun = useApp((s) => s.cancelRun);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const timeStr = formatElapsed(elapsedMs);

  return (
    <button
      className="flex h-[26px] items-center gap-1.5 rounded-md border border-primary/40 bg-primary/12 px-2.5"
      onClick={() => void cancelRun()}
      title="Click to stop"
    >
      <Loader2 className="h-3 w-3 animate-spin text-primary" />
      <span className="text-[11.5px] font-medium text-primary/80">Running…</span>
      <span className="font-mono text-[10px] text-primary">{timeStr}</span>
    </button>
  );
}
