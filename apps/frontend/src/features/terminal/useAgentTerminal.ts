/**
 * useAgentTerminal (Part 6.3) — the thin React glue between the verified
 * {@link reduceAgentTerminal} core and the live xterm panes.
 *
 * It folds the gateway's cumulative `CommandEvent` frames into the pure model
 * (start → output → exit), mirrors the store's focused pane into the model, and
 * streams each new output segment into the agent pane's live xterm via
 * {@link writeToTerminal}. All stateful decisions live in the pure core; this
 * hook only performs the side effects React needs (dispatch + xterm writes +
 * focus mirroring). User typing is never routed through here, so xterm keeps
 * delivering keystrokes to the PTY uninterrupted while the agent streams.
 */
import { useCallback, useEffect, useReducer, useRef } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { writeToTerminal } from "@/lib/terminal-manager";
import {
  AGENT_RUN_END_SEPARATOR,
  deriveEventsFromCommand,
  formatRunStartMarker,
  initialAgentTerminalState,
  reduceAgentTerminal,
  type AgentTerminalEvent,
  type AgentTerminalState,
  type CommandBookkeeping,
} from "./agent-terminal";

export interface UseAgentTerminalOptions {
  /** Cumulative, append-only command frames from the agent stream. */
  commandEvents: readonly AgentEvents.CommandEvent[];
  /** The store's currently focused pane id (mirrored into the model). */
  focusedPaneId: string | null;
  /** Resolve a pane id to its live terminal (session) id, or null. */
  sessionIdOf: (paneId: string) => string | null;
  /** Called when following moves the effective focus (push back to the store). */
  onFocusChange?: (paneId: string) => void;
  /** Injectable xterm writer (defaults to the terminal manager); eases testing. */
  writeToPane?: (sessionId: string, data: string) => void;
}

export interface UseAgentTerminalResult {
  state: AgentTerminalState;
  setFollowAgent: (value: boolean) => void;
  focusPane: (paneId: string) => void;
}

/** ANSI-dressed xterm text for a written output segment. */
function renderSegment(event: AgentTerminalEvent): string {
  switch (event.kind) {
    case "run-start":
      return `\r\n\x1b[38;5;141m${formatRunStartMarker(event.command)}\x1b[0m\r\n`;
    case "run-output":
      return event.chunk;
    case "run-exit":
      return `\r\n\x1b[2m${AGENT_RUN_END_SEPARATOR}\x1b[0m\r\n`;
    default:
      return "";
  }
}

export function useAgentTerminal(
  options: UseAgentTerminalOptions,
): UseAgentTerminalResult {
  const {
    commandEvents,
    focusedPaneId,
    sessionIdOf,
    onFocusChange,
    writeToPane = writeToTerminal,
  } = options;

  const [state, dispatch] = useReducer(
    reduceAgentTerminal,
    focusedPaneId,
    initialAgentTerminalState,
  );

  // Fresh copies for the command-processing effect, which must depend only on
  // the event list (not re-run when focus/resolvers change identity).
  const focusRef = useRef(focusedPaneId);
  focusRef.current = focusedPaneId;
  const sessionIdOfRef = useRef(sessionIdOf);
  sessionIdOfRef.current = sessionIdOf;
  const writeRef = useRef(writeToPane);
  writeRef.current = writeToPane;

  const processedSeqRef = useRef<Set<number>>(new Set());
  const bookRef = useRef<CommandBookkeeping>({
    started: new Set<string>(),
    ended: new Set<string>(),
  });
  const agentPaneRef = useRef<string | null>(null);
  const feedRunRef = useRef<string | null>(null);

  // Mirror the store's focus into the model.
  useEffect(() => {
    if (focusedPaneId !== null) {
      dispatch({ kind: "focus-pane", paneId: focusedPaneId });
    }
  }, [focusedPaneId]);

  // Fold only the newly-arrived cumulative CommandEvent frames.
  useEffect(() => {
    const firstRunId = commandEvents[0]?.runId ?? null;
    if (firstRunId !== feedRunRef.current) {
      processedSeqRef.current = new Set<number>();
      bookRef.current = { started: new Set<string>(), ended: new Set<string>() };
      agentPaneRef.current = null;
    }
    feedRunRef.current = firstRunId;

    const write = (paneId: string | null, event: AgentTerminalEvent): void => {
      if (paneId === null) return;
      const sessionId = sessionIdOfRef.current(paneId);
      if (sessionId !== null) writeRef.current(sessionId, renderSegment(event));
    };
    for (const commandEvent of commandEvents) {
      if (processedSeqRef.current.has(commandEvent.seq)) continue;
      processedSeqRef.current.add(commandEvent.seq);
      const derived = deriveEventsFromCommand(commandEvent, bookRef.current);
      bookRef.current = derived.book;
      for (const event of derived.events) {
        // The agent pane is captured (from the live focus) at run start.
        if (event.kind === "run-start") agentPaneRef.current = focusRef.current;
        write(agentPaneRef.current, event);
        dispatch(event);
      }
    }
  }, [commandEvents]);

  // Follow-agent: propagate the model's effective focus back to the store.
  useEffect(() => {
    if (state.focusedPaneId !== null && state.focusedPaneId !== focusedPaneId) {
      onFocusChange?.(state.focusedPaneId);
    }
  }, [state.focusedPaneId, focusedPaneId, onFocusChange]);

  const setFollowAgent = useCallback(
    (value: boolean) => dispatch({ kind: "set-follow-agent", value }),
    [],
  );
  const focusPane = useCallback(
    (paneId: string) => dispatch({ kind: "focus-pane", paneId }),
    [],
  );

  return { state, setFollowAgent, focusPane };
}

export default useAgentTerminal;
