/**
 * The shared read handle on Gateway telemetry — zoc-agent-chat-rebuild R13.1-R13.5, §16.1, task 26.1.
 *
 * Homed in `lib` because two surviving features read it (`features/terminal`'s agent-occupancy
 * affordances and `features/timeline`'s run trace) while the only *provider* lives inside the tree
 * 26.1 deletes. Moving the context out first means those two consumers keep compiling and keep their
 * current behaviour no matter which way the provider decision goes.
 *
 * The feed shape is declared here rather than in `useAgentStream`, so that this module does not pin a
 * 480-line SSE client alive on a type alias. The client imports these types back.
 */
import { createContext, useContext } from "react";

import type { AgentEvents } from "@zoc-studio/shared-types";

/** Streamed text delta. Frontend-only: the generated contract has no token frame. */
export interface TokenEvent {
  type: "token";
  seq: number;
  runId: string;
  ts: string;
  text: string;
  done?: boolean;
}

/** Transport-level failure surfaced as a frame, so the feed stays one ordered list. */
export interface StreamErrorEvent {
  type: "error";
  seq: number;
  runId?: string;
  ts?: string;
  message: string;
}

/** The flat row-based Event_Contract union (R6.2 single source of truth). */
export type AgentEvent = AgentEvents.AgentEvent | TokenEvent | StreamErrorEvent;

/**
 * Lifecycle of the underlying subscription. `interrupted` is terminal for the transport: the bounded
 * reconnect budget (R8.4) was exhausted, so the client stopped retrying.
 */
export type StreamStatus = "connecting" | "open" | "reconnecting" | "interrupted" | "closed";

export interface AgentStreamFeed {
  /** Append-only, seq-ordered feed (R3.4). */
  events: AgentEvent[];
  /** Current subscription lifecycle state. */
  status: StreamStatus;
}

export const AgentStreamContext = createContext<AgentStreamFeed | null>(null);

/**
 * Null means no provider is mounted above the consumer.
 *
 * Every consumer reads this as `stream?.events ?? []`, which is what makes an absent provider
 * indistinguishable from a provider with nothing to report — a unit test rendering a pane in
 * isolation, and an app with no live run, take the same path.
 */
export function useAgentStreamContext(): AgentStreamFeed | null {
  return useContext(AgentStreamContext);
}
