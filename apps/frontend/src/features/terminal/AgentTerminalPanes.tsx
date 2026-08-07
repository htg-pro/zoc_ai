/**
 * AgentTerminalPanes (Part 6.3) — multi-pane terminal view that streams agent
 * `run_command` output into the focused pane's live xterm.
 *
 * It reuses the verified pane-tree renderer ({@link TerminalPanes}) and the
 * live terminal runtime (`terminal-manager`), layering per-pane agent affordances
 * driven by {@link useAgentTerminal}:
 *   - a completion badge (running / ✓ exit 0 / ✗ exit N),
 *   - an amber "Agent is using this terminal" warning while a run streams here,
 *   - a "Follow agent" toggle that pins focus to the agent pane.
 * The live xterm's own key handling is left untouched, so the user can keep
 * typing into the shell while the agent writes to it (non-blocking).
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
} from "react";
import { AlertTriangle, Check, Crosshair, Lightbulb, Loader2, Search, X } from "lucide-react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { TerminalPanes } from "./TerminalPanes";
import { isPaneAgentActive, paneBadge, type CompletionBadge } from "./agent-terminal";
import { terminalHeader, type TerminalHolder } from "@/lib/terminal-header";
import { isTerminal, type TrackedRun } from "@/lib/agent-runs";
import { AnnotatedOutput } from "./OutputParser";
import { parseTerminalOutput } from "./output-parser";
import { useAgentTerminal } from "./useAgentTerminal";
import { leaves, type TerminalPane } from "@/lib/terminal-layout";
import { activeWorkspaceRoot, useApp, type TerminalProfile } from "@/lib/store";
import { useChatSurface } from "@/features/chat/store";
import { requestReveal, revealPosition } from "@/lib/editor-actions";
import { joinPath } from "@/lib/paths";
import {
  createTerminal,
  findInTerminal,
  getTerminalOutput,
  hasTerminal,
  mountTerminal,
  subscribeTerminalOutput,
  unmountTerminal,
} from "@/lib/terminal-manager";
import { cn } from "@/lib/utils";

export interface AgentTerminalPanesProps {
  /** Cumulative command frames from the agent stream (e.g. filtered feed). */
  commandEvents: readonly AgentEvents.CommandEvent[];
}

export function AgentTerminalPanes({ commandEvents }: AgentTerminalPanesProps): JSX.Element {
  const layout = useApp((s) => s.terminalLayout);
  const focusedPaneId = useApp((s) => s.focusedPaneId);
  const profiles = useApp((s) => s.terminalProfiles);
  const terminals = useApp((s) => s.terminals);
  const workspaceRoot = useApp(activeWorkspaceRoot);
  const trackedRuns = useApp((s) => s.trackedRuns ?? []);

  // The real run currently holding a terminal: the latest command frame that
  // has not exited, mapped to its tracked run. Used to NAME the occupant and to
  // clear occupancy the moment that run reaches any terminal phase (R13.3/R13.4)
  // — cancellation/failure/interruption included — even if no command-exit
  // frame ever arrives (a cancelled run often has none).
  const activeCommandRunId = useMemo(() => {
    for (let i = commandEvents.length - 1; i >= 0; i--) {
      if (commandEvents[i].exitCode == null) return commandEvents[i].runId;
    }
    return null;
  }, [commandEvents]);
  const holderRecord = useMemo<TerminalHolder | null>(() => {
    const run: TrackedRun | undefined = trackedRuns.find((r) => r.runId === activeCommandRunId);
    if (!run) return null;
    // A run that already settled no longer holds the terminal. `isTerminal` covers the same four
    // phases the header's own check did, so this is the whole settled decision — which is why the
    // relocated projection asks the caller for it rather than re-deriving it from a phase union
    // that only the deleted panel owns (task 25.1).
    if (isTerminal(run)) return null;
    return { runId: run.runId, mode: run.mode, settled: false };
  }, [trackedRuns, activeCommandRunId]);

  const sessionIdOf = useCallback(
    (paneId: string): string | null =>
      leaves(layout).find((leaf) => leaf.id === paneId)?.sessionId ?? null,
    [layout],
  );

  const focusInStore = useCallback((paneId: string): void => {
    const current = useApp.getState();
    const sessionId = leaves(current.terminalLayout).find((pane) => pane.id === paneId)?.sessionId;
    useApp.setState({
      focusedPaneId: paneId,
      ...(sessionId ? { activeTerminalId: sessionId } : {}),
    });
  }, []);

  const { state, setFollowAgent, focusPane } = useAgentTerminal({
    commandEvents,
    focusedPaneId,
    sessionIdOf,
    onFocusChange: focusInStore,
  });

  return (
    <TerminalPanes
      node={layout}
      focusedPaneId={focusedPaneId}
      onFocusPane={(paneId) => {
        focusInStore(paneId);
        focusPane(paneId);
      }}
      renderPane={(pane) => (
        <AgentTerminalPaneSurface
          pane={pane}
          badge={paneBadge(state, pane.id)}
          agentActive={isPaneAgentActive(state, pane.id)}
          followAgent={state.followAgent}
          onToggleFollow={() => setFollowAgent(!state.followAgent)}
          holder={holderRecord}
          profile={
            profiles.find(
              (profile) =>
                profile.id ===
                terminals.find((terminal) => terminal.id === pane.sessionId)?.profileId,
            ) ?? profiles[0]
          }
          workspaceRoot={workspaceRoot}
        />
      )}
    />
  );
}

interface AgentTerminalPaneSurfaceProps {
  pane: TerminalPane;
  badge: CompletionBadge;
  agentActive: boolean;
  followAgent: boolean;
  onToggleFollow: () => void;
  holder: TerminalHolder | null;
  profile: TerminalProfile | undefined;
  workspaceRoot: string | null;
}

/** Hosts a manager-owned live xterm plus the agent affordance header. */
function AgentTerminalPaneSurface({
  pane,
  badge,
  agentActive,
  followAgent,
  onToggleFollow,
  holder,
  profile,
  workspaceRoot,
}: AgentTerminalPaneSurfaceProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const { sessionId } = pane;
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  const [showInsights, setShowInsights] = useState(false);
  const subscribeOutput = useCallback(
    (listener: () => void) => subscribeTerminalOutput(sessionId, listener),
    [sessionId],
  );
  const readOutput = useCallback(() => getTerminalOutput(sessionId), [sessionId]);
  const output = useSyncExternalStore(subscribeOutput, readOutput, () => "");
  // R13.1/R13.5 — the terminal header reports the resolved workspace root as
  // cwd and the exit status when a process exited non-zero. Occupancy (R13.3/
  // R13.4) names the actual holding run and is cleared the instant that run is
  // terminal (holderRecord becomes null), even without a command-exit frame.
  const header = terminalHeader({
    resolvedRoot: workspaceRoot,
    holder,
    exitCode: badge.status === "fail" ? badge.exitCode : badge.status === "ok" ? 0 : null,
  });
  // The occupancy banner shows only on the pane the agent is writing to AND
  // only while the holding run is non-terminal (header.occupancy != null).
  const showOccupancy = agentActive && header.occupancy !== null;
  const insights = useMemo(() => {
    const lines = parseTerminalOutput(output.slice(-16 * 1024)).filter(
      (line) =>
        line.annotations.length > 0 || (line.text.includes("\r") && /\d+\s*%/.test(line.text)),
    );
    return {
      count: lines.length,
      text: lines
        .slice(-12)
        .map((line) => line.text)
        .join("\n"),
    };
  }, [output]);

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    let cancelled = false;
    // The instance may still be spawning; poll briefly until it exists so the
    // live shell keeps its scrollback across mounts.
    const attach = (): void => {
      if (cancelled) return;
      if (hasTerminal(sessionId)) {
        mountTerminal(sessionId, el);
      } else {
        if (profile) void createTerminal(sessionId, profile, workspaceRoot);
        setTimeout(attach, 50);
      }
    };
    attach();
    return () => {
      cancelled = true;
      unmountTerminal(sessionId);
    };
  }, [sessionId, profile, workspaceRoot]);

  const annotationHandlers = {
    onOpenPath: (path: string, line = 1, column = 1): void => {
      const state = useApp.getState();
      const absolute =
        path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || !state.workspaceRoot
          ? path
          : joinPath(state.workspaceRoot, path);
      if (absolute === state.activeFile) {
        void state.openFile(absolute);
        revealPosition(line, column);
      } else {
        requestReveal(absolute, line, column);
        void state.openFile(absolute);
      }
    },
    onOpenUrl: (url: string): void => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    onFixWithAgent: (text: string): void => {
      const state = useApp.getState();
      // The Chat_Surface's draft, not the app store's `input`: since 25.6 the mounted composer reads
      // the former, so writing the latter opened the panel onto an empty box.
      useChatSurface.getState().setDraft(`Fix this terminal error:\n\n${text}`);
      useChatSurface.getState().setConversationMode("agent");
      if (!state.layout.rightPanelOpen) state.toggleRight();
    },
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0a0a0d]">
      <div className="flex h-6 shrink-0 items-center justify-between gap-2 border-b border-border bg-card/40 px-2">
        <div className="flex min-w-0 items-center gap-2">
          {header.cwd && (
            <span
              className="max-w-[180px] truncate font-mono text-[10px] text-muted-foreground"
              title={header.cwd}
              data-testid="terminal-cwd"
            >
              {header.cwd}
            </span>
          )}
          <CompletionBadgeView badge={badge} />
          {showOccupancy && (
            <span
              role="status"
              data-testid="agent-active-warning"
              data-run-id={header.occupancy?.runId}
              className="flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500"
            >
              <AlertTriangle className="h-3 w-3" />
              {header.occupancy?.label ?? "A run is using this terminal"}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {insights.count > 0 && (
            <button
              type="button"
              aria-label="Toggle output insights"
              aria-pressed={showInsights}
              title="Output insights"
              onClick={() => setShowInsights((visible) => !visible)}
              className={cn(
                "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
                showInsights
                  ? "bg-[var(--zoc-info)]/15 text-[var(--zoc-info)]"
                  : "text-muted-foreground hover:bg-accent/60",
              )}
            >
              <Lightbulb className="h-3 w-3" />
              {insights.count}
            </button>
          )}
          <button
            type="button"
            aria-label="Find in terminal"
            title="Find in terminal"
            onClick={() => setFinding((visible) => !visible)}
            className="rounded p-0.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          >
            <Search className="h-3 w-3" />
          </button>
          <button
            type="button"
            role="switch"
            aria-checked={followAgent}
            aria-label="Follow agent"
            title="Follow agent"
            onClick={onToggleFollow}
            className={cn(
              "flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] transition-colors",
              followAgent
                ? "bg-[var(--zoc-ember)]/20 text-[var(--zoc-ember)]"
                : "text-muted-foreground hover:bg-accent/60",
            )}
          >
            <Crosshair className="h-3 w-3" />
            Follow agent
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        {finding && (
          <div className="absolute right-2 top-2 z-30 flex items-center gap-1 rounded border border-border bg-card px-1.5 py-1 shadow-lg">
            <Search className="h-3 w-3 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  findInTerminal(sessionId, query, event.shiftKey ? "prev" : "next");
                } else if (event.key === "Escape") {
                  setFinding(false);
                }
              }}
              placeholder="Find"
              className="h-5 w-36 bg-transparent text-[11px] outline-none"
            />
            <button type="button" aria-label="Close find" onClick={() => setFinding(false)}>
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          </div>
        )}
        <div
          ref={hostRef}
          className="h-full min-h-0"
          onKeyDownCapture={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
              event.preventDefault();
              setFinding(true);
            }
          }}
        />
        {showInsights && insights.text && (
          <div
            className="absolute inset-x-2 bottom-2 z-20 max-h-[45%] overflow-auto rounded border border-border bg-card/95 p-2 shadow-xl backdrop-blur"
            role="region"
            aria-label="Terminal output insights"
          >
            <div className="mb-1 flex items-center justify-between text-[10px] font-medium text-muted-foreground">
              <span>Output insights</span>
              <button
                type="button"
                aria-label="Close output insights"
                onClick={() => setShowInsights(false)}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
            <AnnotatedOutput text={insights.text} handlers={annotationHandlers} />
          </div>
        )}
      </div>
    </div>
  );
}

/** The ✓ / ✗ / running completion badge for a pane's latest agent run. */
function CompletionBadgeView({ badge }: { badge: CompletionBadge }): JSX.Element | null {
  switch (badge.status) {
    case "idle":
      return null;
    case "running":
      return (
        <span
          data-badge="running"
          className="flex items-center gap-1 text-[10px] text-muted-foreground"
        >
          <Loader2 className="h-3 w-3 animate-spin" />
          running
        </span>
      );
    case "ok":
      return (
        <span data-badge="ok" className="flex items-center gap-1 text-[10px] text-emerald-500">
          <Check className="h-3 w-3" />
          exit 0
        </span>
      );
    case "fail":
      return (
        <span data-badge="fail" className="flex items-center gap-1 text-[10px] text-destructive">
          <X className="h-3 w-3" />
          exit {badge.exitCode}
        </span>
      );
  }
}

export default AgentTerminalPanes;
