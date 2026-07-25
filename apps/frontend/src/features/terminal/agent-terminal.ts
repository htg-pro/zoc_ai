/**
 * Agent ↔ terminal routing core (Part 6.3, pure/dependency-free).
 *
 * A deterministic reducer that folds a stream of agent `run_command` lifecycle
 * events (start / output / exit) together with user actions (focus a pane,
 * toggle "follow agent", type into a pane) into a per-pane routing model:
 *
 *   - the *agent pane* is whichever pane was focused when a run started; all of
 *     that run's output is appended there, bracketed by a run-START marker and
 *     exactly one run-END separator;
 *   - a completion *badge* per pane (`running` while in flight, `ok` on exit 0,
 *     `fail` with the code otherwise);
 *   - an `agentActive` flag on the pane the agent is currently writing to;
 *   - a `followAgent` toggle that, while on, pins focus to the agent pane.
 *
 * User-typing events are recorded unconditionally and are never gated on the
 * agent being active — typing into a terminal must stay non-blocking while the
 * agent streams output into it. The React/xterm layer sits on top of this
 * verified core; this module imports nothing framework-specific (the single
 * import is a type-only reference to the shared event contract).
 */
import type { AgentEvents } from "@zoc-studio/shared-types";

/** The run-END separator appended exactly once when a command exits. */
export const AGENT_RUN_END_SEPARATOR = "────────────────────────────────";

/** Build the run-START marker line shown before a command's output. */
export function formatRunStartMarker(command: string): string {
  return `❯ ${command}`;
}

/** Completion badge for a pane's most recent (or in-flight) agent run. */
export type CompletionBadge =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; exitCode: 0 }
  | { status: "fail"; exitCode: number };

/** One appended piece of a pane's agent-output log, in emission order. */
export type OutputSegment =
  | { type: "start"; runId: string; command: string; text: string }
  | { type: "chunk"; runId: string; text: string }
  | { type: "end"; runId: string; exitCode: number; text: string };

/** A single recorded user-typing event. */
export interface UserInput {
  paneId: string;
  data: string;
}

/** Per-pane routing runtime. */
export interface PaneRuntime {
  paneId: string;
  /** Appended agent output (START marker, chunks, single END separator). */
  output: OutputSegment[];
  /** Badge for the current/last run routed to this pane. */
  badge: CompletionBadge;
  /** True while the agent is actively streaming a run into this pane. */
  agentActive: boolean;
}

/** The full routing model. */
export interface AgentTerminalState {
  /** Pane the agent is writing to (the focused pane captured at run start). */
  agentPaneId: string | null;
  /** Effective focused pane (pinned to the agent pane while following). */
  focusedPaneId: string | null;
  /** When on, focus is routed to the agent pane. */
  followAgent: boolean;
  /** Active run id, or null when no run is in flight. */
  activeRunId: string | null;
  /** Per-pane runtime keyed by pane id. */
  panes: Record<string, PaneRuntime>;
  /** Append-only log of user-typing events — proof they are never dropped. */
  userInputLog: UserInput[];
}

/** Normalized events the reducer folds. */
export type AgentTerminalEvent =
  | { kind: "run-start"; runId: string; command: string }
  | { kind: "run-output"; runId: string; chunk: string }
  | { kind: "run-exit"; runId: string; exitCode: number }
  | { kind: "set-follow-agent"; value: boolean }
  | { kind: "focus-pane"; paneId: string }
  | { kind: "user-input"; paneId: string; data: string };

/** A fresh model, optionally seeded with the currently focused pane. */
export function initialAgentTerminalState(
  focusedPaneId: string | null = null,
): AgentTerminalState {
  return {
    agentPaneId: null,
    focusedPaneId,
    followAgent: false,
    activeRunId: null,
    panes: {},
    userInputLog: [],
  };
}

function ensurePane(
  panes: Record<string, PaneRuntime>,
  paneId: string,
): PaneRuntime {
  return (
    panes[paneId] ?? {
      paneId,
      output: [],
      badge: { status: "idle" },
      agentActive: false,
    }
  );
}

/** While following, pin the effective focus to the agent pane. */
function normalize(state: AgentTerminalState): AgentTerminalState {
  if (
    state.followAgent &&
    state.agentPaneId !== null &&
    state.focusedPaneId !== state.agentPaneId
  ) {
    return { ...state, focusedPaneId: state.agentPaneId };
  }
  return state;
}

/** Fold one normalized event into the model. Pure: never mutates `state`. */
export function reduceAgentTerminal(
  state: AgentTerminalState,
  event: AgentTerminalEvent,
): AgentTerminalState {
  switch (event.kind) {
    case "run-start": {
      // The agent pane is whichever pane is focused at run start.
      const paneId = state.focusedPaneId;
      if (paneId === null) return state; // no focused pane to route into
      const pane = ensurePane(state.panes, paneId);
      const segment: OutputSegment = {
        type: "start",
        runId: event.runId,
        command: event.command,
        text: formatRunStartMarker(event.command),
      };
      return normalize({
        ...state,
        agentPaneId: paneId,
        activeRunId: event.runId,
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            output: [...pane.output, segment],
            badge: { status: "running" },
            agentActive: true,
          },
        },
      });
    }
    case "run-output": {
      const paneId = state.agentPaneId;
      // Only append output belonging to the active run in the agent pane.
      if (paneId === null || state.activeRunId !== event.runId) return state;
      const pane = ensurePane(state.panes, paneId);
      const segment: OutputSegment = {
        type: "chunk",
        runId: event.runId,
        text: event.chunk,
      };
      return normalize({
        ...state,
        panes: {
          ...state.panes,
          [paneId]: { ...pane, output: [...pane.output, segment] },
        },
      });
    }
    case "run-exit": {
      const paneId = state.agentPaneId;
      // Guard on the active run so a duplicate/late exit can't append a second
      // END separator (the exactly-one invariant).
      if (paneId === null || state.activeRunId !== event.runId) return state;
      const pane = ensurePane(state.panes, paneId);
      const segment: OutputSegment = {
        type: "end",
        runId: event.runId,
        exitCode: event.exitCode,
        text: AGENT_RUN_END_SEPARATOR,
      };
      const badge: CompletionBadge =
        event.exitCode === 0
          ? { status: "ok", exitCode: 0 }
          : { status: "fail", exitCode: event.exitCode };
      return normalize({
        ...state,
        activeRunId: null,
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            output: [...pane.output, segment],
            badge,
            agentActive: false,
          },
        },
      });
    }
    case "set-follow-agent":
      return normalize({ ...state, followAgent: event.value });
    case "focus-pane":
      return normalize({ ...state, focusedPaneId: event.paneId });
    case "user-input":
      // Non-blocking: recorded unconditionally, even while the agent is active.
      return {
        ...state,
        userInputLog: [
          ...state.userInputLog,
          { paneId: event.paneId, data: event.data },
        ],
      };
  }
}

/** Fold a batch of events (left-to-right) into the model. */
export function runAgentTerminal(
  state: AgentTerminalState,
  events: readonly AgentTerminalEvent[],
): AgentTerminalState {
  return events.reduce(reduceAgentTerminal, state);
}

// --- selectors ------------------------------------------------------------

export function paneRuntime(
  state: AgentTerminalState,
  paneId: string,
): PaneRuntime | undefined {
  return state.panes[paneId];
}

export function paneBadge(
  state: AgentTerminalState,
  paneId: string,
): CompletionBadge {
  return state.panes[paneId]?.badge ?? { status: "idle" };
}

export function isPaneAgentActive(
  state: AgentTerminalState,
  paneId: string,
): boolean {
  return (
    state.agentPaneId === paneId && state.panes[paneId]?.agentActive === true
  );
}

export function paneOutputText(
  state: AgentTerminalState,
  paneId: string,
): string[] {
  return state.panes[paneId]?.output.map((segment) => segment.text) ?? [];
}

// --- CommandEvent adapter -------------------------------------------------

/** Stable key that groups the cumulative frames of a single agent command. */
export function commandKey(
  event: Pick<AgentEvents.CommandEvent, "runId" | "commandId" | "command">,
): string {
  return `${event.runId}:${event.commandId ?? event.command}`;
}

/** Bookkeeping of which command keys have already emitted a start / exit. */
export interface CommandBookkeeping {
  started: ReadonlySet<string>;
  ended: ReadonlySet<string>;
}

/**
 * Translate one cumulative `CommandEvent` frame into ordered normalized events.
 * Because the gateway upserts a command's frames, `started`/`ended` de-dupe the
 * run-start and run-exit so repeated frames only ever emit fresh output. Pure:
 * returns new bookkeeping sets rather than mutating the inputs.
 */
export function deriveEventsFromCommand(
  event: AgentEvents.CommandEvent,
  book: CommandBookkeeping,
): { events: AgentTerminalEvent[]; book: CommandBookkeeping } {
  const key = commandKey(event);
  const events: AgentTerminalEvent[] = [];
  const started = new Set(book.started);
  const ended = new Set(book.ended);

  if (!started.has(key)) {
    started.add(key);
    events.push({ kind: "run-start", runId: key, command: event.command });
  }
  if (event.outputDelta) {
    events.push({ kind: "run-output", runId: key, chunk: event.outputDelta });
  }
  if (event.exitCode != null && !ended.has(key)) {
    ended.add(key);
    events.push({ kind: "run-exit", runId: key, exitCode: event.exitCode });
  }

  return { events, book: { started, ended } };
}
