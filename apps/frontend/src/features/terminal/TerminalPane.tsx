import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronDown,
  Plus,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentStreamContext } from "@/features/agent/agent-stream-context";
import { AgentTerminalPanes } from "./AgentTerminalPanes";
import { useTerminalPaneShortcuts } from "./useTerminalPaneShortcuts";
import { requestReveal, revealPosition } from "@/lib/editor-actions";
import { joinPath } from "@/lib/paths";
import { activeWorkspaceRoot, useApp } from "@/lib/store";
import {
  disposeTerminal,
  ensureTerminalCwd,
  killTerminal,
  setTerminalCallbacks,
} from "@/lib/terminal-manager";
import {
  leaves,
  MAX_PANES,
  paneCount,
  type TerminalPane as TerminalPaneLeaf,
} from "@/lib/terminal-layout";
import { cn } from "@/lib/utils";

/** Live terminal dock backed by the bounded split-pane tree. */
export function TerminalPane() {
  useTerminalPaneShortcuts();
  const terminals = useApp((state) => state.terminals);
  const activeId = useApp((state) => state.activeTerminalId);
  const profiles = useApp((state) => state.terminalProfiles);
  const layout = useApp((state) => state.terminalLayout);
  const focusedPaneId = useApp((state) => state.focusedPaneId);
  const closeTerminalPane = useApp((state) => state.closeTerminalPane);
  const setActiveTerminal = useApp((state) => state.setActiveTerminal);
  const renameTerminal = useApp((state) => state.renameTerminal);
  const workspaceRoot = useApp(activeWorkspaceRoot);
  const sharedStream = useAgentStreamContext();

  const commandEvents = useMemo(
    () =>
      (sharedStream?.events ?? []).filter(
        (event): event is AgentEvents.CommandEvent => event.type === "command",
      ),
    [sharedStream?.events],
  );
  const panes = useMemo(() => leaves(layout), [layout]);
  const atPaneLimit = paneCount(layout) >= MAX_PANES;

  const addPane = useCallback(
    (direction: "row" | "column", profileId?: string): void => {
      const current = useApp.getState();
      if (paneCount(current.terminalLayout) >= MAX_PANES) return;
      const sessionId = current.newTerminal(profileId);
      if (current.terminalLayout === null) {
        useApp.getState().ensureTerminalPane(sessionId);
      } else {
        useApp.getState().splitActivePane(direction, sessionId);
      }
    },
    [],
  );

  // Seed exactly one terminal/pane on first mount. Reading current state inside
  // the effect keeps this idempotent under React StrictMode's effect replay.
  useEffect(() => {
    const current = useApp.getState();
    if (current.terminalLayout !== null) return;
    const existing =
      current.terminals.find((terminal) => terminal.id === current.activeTerminalId)?.id ??
      current.terminals[0]?.id;
    const sessionId = existing ?? current.newTerminal();
    useApp.getState().ensureTerminalPane(sessionId);
  }, []);

  // Reconcile every visible pane with one manager-owned xterm/PTY instance.
  // `ensureTerminalCwd` (not `createTerminal`) is deliberate: the previous
  // version skipped any pane that already had an instance, so switching
  // workspaces left the old PTY — still sitting in the previous project's
  // directory — attached to the pane.
  useEffect(() => {
    for (const pane of panes) {
      const terminal = terminals.find((candidate) => candidate.id === pane.sessionId);
      const profile =
        profiles.find((candidate) => candidate.id === terminal?.profileId) ?? profiles[0];
      if (profile) void ensureTerminalCwd(pane.sessionId, profile, workspaceRoot);
    }
  }, [panes, profiles, terminals, workspaceRoot]);

  // Wire PTY exits and clickable native xterm path links into store/editor state.
  useEffect(() => {
    setTerminalCallbacks({
      onExit: (id, code) => useApp.getState().setTerminalExited(id, code),
      onOpenLink: (path, line = 1) => {
        const state = useApp.getState();
        const root = activeWorkspaceRoot(state);
        const absolute =
          path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || !root
            ? path
            : joinPath(root, path);
        if (absolute === state.activeFile) {
          void state.openFile(absolute);
          revealPosition(line, 1);
        } else {
          requestReveal(absolute, line, 1);
          void state.openFile(absolute);
        }
      },
    });
  }, []);

  const closePane = useCallback(
    (pane: TerminalPaneLeaf): void => {
      void disposeTerminal(pane.sessionId);
      closeTerminalPane(pane.id);
    },
    [closeTerminalPane],
  );

  const focusedPane = panes.find((pane) => pane.id === focusedPaneId) ?? null;
  const focusedSessionId = focusedPane?.sessionId ?? activeId;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-[#0a0a0d]">
      <div className="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-card/40 px-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" role="tablist">
          {panes.map((pane) => {
            const terminal = terminals.find((candidate) => candidate.id === pane.sessionId);
            return (
              <TerminalTab
                key={pane.id}
                title={terminal?.title ?? "Terminal"}
                status={terminal?.status ?? "running"}
                exitCode={terminal?.exitCode ?? null}
                active={pane.id === focusedPaneId}
                onSelect={() => {
                  setActiveTerminal(pane.sessionId);
                  useApp.setState({ focusedPaneId: pane.id });
                }}
                onClose={() => closePane(pane)}
                onRename={(title) => renameTerminal(pane.sessionId, title)}
              />
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <div className="flex items-center">
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6"
              title="New terminal pane"
              aria-label="New terminal pane"
              disabled={atPaneLimit}
              onClick={() => addPane("row")}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="flex h-6 w-4 items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-40"
                  aria-label="Select shell profile"
                  title="Select shell profile"
                  disabled={atPaneLimit}
                >
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {profiles.map((profile) => (
                  <DropdownMenuItem
                    key={profile.id}
                    onSelect={() => addPane("row", profile.id)}
                  >
                    <TerminalIcon className="mr-2 h-3.5 w-3.5" />
                    {profile.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Split terminal right (Ctrl/Cmd+D)"
            aria-label="Split terminal right"
            disabled={atPaneLimit || layout === null}
            onClick={() => addPane("row")}
          >
            <SplitSquareHorizontal className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Split terminal down (Ctrl/Cmd+Shift+D)"
            aria-label="Split terminal down"
            disabled={atPaneLimit || layout === null}
            onClick={() => addPane("column")}
          >
            <SplitSquareVertical className="h-3.5 w-3.5" />
          </Button>
          {focusedSessionId && (
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              title="Kill terminal"
              aria-label="Kill terminal"
              onClick={() => void killTerminal(focusedSessionId)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1">
        {layout ? (
          <AgentTerminalPanes commandEvents={commandEvents} />
        ) : (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
            No terminal pane. Use + to open one.
          </div>
        )}
      </div>
    </div>
  );
}

function TerminalTab({
  title,
  status,
  exitCode,
  active,
  onSelect,
  onClose,
  onRename,
}: {
  title: string;
  status: "running" | "exited";
  exitCode: number | null;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          onRename(draft);
          setEditing(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            onRename(draft);
            setEditing(false);
          } else if (event.key === "Escape") {
            setEditing(false);
          }
        }}
        className="h-6 w-28 rounded border border-primary/50 bg-background px-1 text-[11px] outline-none"
      />
    );
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      onDoubleClick={() => {
        setDraft(title);
        setEditing(true);
      }}
      className={cn(
        "group flex h-6 cursor-pointer items-center gap-1.5 rounded px-2 text-[11px]",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
      )}
    >
      <TerminalIcon className="h-3 w-3 shrink-0" />
      <span className="max-w-[140px] truncate">{title}</span>
      {status === "exited" && (
        <span
          className={cn(
            "font-mono text-[9px]",
            exitCode === 0 ? "text-emerald-500" : "text-destructive",
          )}
          title={`Exited with code ${exitCode ?? "?"}`}
        >
          [{exitCode ?? "?"}]
        </span>
      )}
      <button
        type="button"
        aria-label={`Close ${title}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="opacity-0 group-hover:opacity-100 focus:opacity-100"
      >
        <X className="h-3 w-3 hover:text-foreground" />
      </button>
    </div>
  );
}
