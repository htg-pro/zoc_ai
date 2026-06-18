/**
 * useAgentStream.ts — the single frontend SSE client for the Zoc Agent panel.
 *
 * Ported from `apps/workbench/src/useAgentStream.ts` (branch
 * `zocai-ecosystem-rebuild`) into the preserved `apps/frontend` shell. This is
 * the ONE SSE consumer for the Gateway telemetry channel (R6.3); it replaces
 * both `lib/sse.ts` and the bespoke event-stream machinery in
 * `lib/agent-client.ts`.
 *
 * Requirements (merge spec):
 * - R3.1: WHEN the Agent_Panel mounts, THE Run_Feed SHALL subscribe to the
 *   Gateway SSE_Stream (`GET /v1/agent/events`).
 * - R3.4: THE Run_Feed SHALL append received Event_Rows in emission order
 *   without altering previously rendered rows — realized by the append-only,
 *   seq-ordered `mergeEventBySeq`/`mergeEvents` fold (duplicate `seq` dropped,
 *   never mutated).
 * - R3.5: a payload with an unrecognized/non-conforming shape is discarded
 *   while the stream stays open (`parseFrame` returns `null`).
 * - R6.3: exactly one SSE client implementation.
 * - R11.1/R11.3: the branch's `@llama-studio/shared-types` import is rewritten
 *   to the canonical `@zoc-studio/shared-types`.
 * - On a dropped stream the feed is rebuilt from the trailing
 *   `GET /v1/agent/diary` entries before resuming live (recovery; carries over
 *   Rebuild-R10.2).
 *
 * The hook is intentionally transport-injectable: the SSE stream factory
 * (`createStream`), the diary-recovery fetch (`recoverFromDiary`), and the
 * loopback base-URL resolver (`resolveBaseUrl`) are parameters with sensible
 * defaults. The default `resolveBaseUrl` reuses the existing Tauri readiness
 * wait (`agentPort()` / `agentStatus()` from `tauri-bridge.ts`) so the events
 * URL is built from the resolved loopback port, exactly as the rest of the app
 * does. Tests can supply stubs to exercise the ordering/merge logic without a
 * live Gateway.
 *
 * See design.md "New: single SSE client `useAgentStream.ts`".
 */
import { useEffect, useRef, useState } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { resolveAgentPort } from "@/lib/agent-port";

/** The flat row-based Event_Contract union (R6.2 single source of truth). */
export type AgentEvent = AgentEvents.AgentEvent;

/** Gateway telemetry channel — the single ordered SSE stream (design.md). */
export const AGENT_EVENTS_ENDPOINT = "/v1/agent/events";

/**
 * Recovery endpoint backed by `.zocai/session_diary.jsonl`. On reconnect the
 * hook reads the trailing diary entries from here to rebuild the feed before
 * resuming live streaming (Rebuild-R10.2).
 */
export const AGENT_DIARY_ENDPOINT = "/v1/agent/diary";

/** Default delay before re-subscribing after a dropped stream. */
export const DEFAULT_RECONNECT_DELAY_MS = 1000;

/** Lifecycle of the underlying SSE subscription. */
export type StreamStatus = "connecting" | "open" | "reconnecting" | "closed";

/**
 * Minimal, injectable view of an SSE connection. The browser `EventSource`
 * satisfies this shape; tests can supply a stub that drives the handlers
 * directly without a network.
 */
export interface AgentEventStream {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

/** Opens a new SSE connection to `url`. */
export type EventStreamFactory = (url: string) => AgentEventStream;

/** Reads the trailing diary entries used to rebuild the feed on reconnect. */
export type DiaryRecovery = (url: string) => Promise<AgentEvent[]>;

/** Resolves the loopback base URL (e.g. `http://127.0.0.1:<port>`) the events
 *  and diary endpoints are appended to. Returns `""` for a relative base. */
export type BaseUrlResolver = () => Promise<string>;

export interface UseAgentStreamOptions {
  /** Telemetry endpoint path. Defaults to {@link AGENT_EVENTS_ENDPOINT}. */
  eventsUrl?: string;
  /** Recovery endpoint path. Defaults to {@link AGENT_DIARY_ENDPOINT}. */
  diaryUrl?: string;
  /** Opens the SSE connection. Defaults to the browser `EventSource`. */
  createStream?: EventStreamFactory;
  /** Fetches trailing diary entries. Defaults to a `fetch` of `diaryUrl`. */
  recoverFromDiary?: DiaryRecovery;
  /**
   * Resolves the loopback base URL before subscribing, reusing the existing
   * Tauri readiness wait. Defaults to {@link defaultResolveBaseUrl}.
   */
  resolveBaseUrl?: BaseUrlResolver;
  /** Delay before re-subscribing after a drop. Defaults to 1000 ms. */
  reconnectDelayMs?: number;
  /** Active Gateway run id to subscribe to. Omitted/null opens the ping stream. */
  runId?: string | null;
}

export interface UseAgentStreamResult {
  /** Append-only, seq-ordered feed (R3.4). */
  events: AgentEvent[];
  /** Current subscription lifecycle state. */
  status: StreamStatus;
}

/**
 * Inserts `incoming` into a seq-ordered, append-only feed.
 *
 * The feed is keyed by `seq`: an event whose `seq` is already present is a
 * duplicate (e.g. a diary entry that also arrived live) and is ignored, so
 * previously rendered rows are never mutated or replaced (R3.4). Otherwise the
 * event is placed so the array stays in ascending `seq` order.
 */
export function mergeEventBySeq(events: AgentEvent[], incoming: AgentEvent): AgentEvent[] {
  let insertAt = events.length;
  for (let i = 0; i < events.length; i++) {
    if (events[i].seq === incoming.seq) {
      return events; // append-only: keep the existing row, drop the duplicate
    }
    if (events[i].seq > incoming.seq) {
      insertAt = i;
      break;
    }
  }
  if (insertAt === events.length) {
    return [...events, incoming];
  }
  return [...events.slice(0, insertAt), incoming, ...events.slice(insertAt)];
}

/** Folds a batch of events into the feed, preserving seq order and dedup. */
export function mergeEvents(events: AgentEvent[], incoming: readonly AgentEvent[]): AgentEvent[] {
  let next = events;
  for (const ev of incoming) {
    next = mergeEventBySeq(next, ev);
  }
  return next;
}

/** Default browser SSE factory. */
const defaultCreateStream: EventStreamFactory = (url) =>
  new EventSource(url) as unknown as AgentEventStream;

/** Default diary recovery: GET the recovery endpoint and parse an event array. */
const defaultRecoverFromDiary: DiaryRecovery = async (url) => {
  const response = await fetch(url);
  if (!response.ok) {
    return [];
  }
  const payload: unknown = await response.json();
  return Array.isArray(payload) ? (payload as AgentEvent[]) : [];
};

/**
 * Default base-URL resolver. Reuses the existing Tauri port resolution and
 * readiness wait so the SSE client connects to the same loopback sidecar as
 * the rest of the app.
 */
export const defaultResolveBaseUrl: BaseUrlResolver = async () => {
  const port = await resolveAgentPort();
  return `http://127.0.0.1:${port}`;
};

function withRunId(path: string, runId: string | null | undefined): string {
  if (!runId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}runId=${encodeURIComponent(runId)}`;
}

/** Parses a single SSE `data` frame into an AgentEvent, or null if malformed. */
export function parseFrame(data: string): AgentEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    if (value && typeof value === "object" && typeof (value as AgentEvent).seq === "number") {
      return value as AgentEvent;
    }
  } catch {
    // Non-conforming frames are ignored; the stream stays open (R3.5).
  }
  return null;
}

/**
 * Subscribes to the Gateway SSE bus on mount and exposes an append-only,
 * seq-ordered feed. It first resolves the loopback base URL (reusing the Tauri
 * readiness wait), then subscribes to `GET /v1/agent/events` (R3.1). On a
 * dropped connection it rebuilds the feed from the trailing diary entries
 * before resuming live streaming (R3.4, R3.5, Rebuild-R10.2).
 */
export function useAgentStream(options: UseAgentStreamOptions = {}): UseAgentStreamResult {
  const {
    eventsUrl = AGENT_EVENTS_ENDPOINT,
    diaryUrl = AGENT_DIARY_ENDPOINT,
    createStream = defaultCreateStream,
    recoverFromDiary = defaultRecoverFromDiary,
    resolveBaseUrl = defaultResolveBaseUrl,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    runId = null,
  } = options;

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>("connecting");

  // Stable refs so handlers always see fresh config between reconnects.
  const optionRefs = useRef({
    eventsUrl,
    diaryUrl,
    createStream,
    recoverFromDiary,
    resolveBaseUrl,
    reconnectDelayMs,
    runId,
  });
  optionRefs.current = {
    eventsUrl,
    diaryUrl,
    createStream,
    recoverFromDiary,
    resolveBaseUrl,
    reconnectDelayMs,
    runId,
  };

  useEffect(() => {
    let cancelled = false;
    let stream: AgentEventStream | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    // Resolved once before the first subscribe; the events/diary endpoints are
    // appended to it so reconnects reuse the same loopback origin.
    let baseUrl = "";

    const appendFrame = (data: string): void => {
      const event = parseFrame(data);
      if (event !== null) {
        setEvents((prev) => mergeEventBySeq(prev, event));
      }
    };

    const subscribe = (): void => {
      if (cancelled) {
        return;
      }
      const {
        eventsUrl: path,
        createStream: open,
        runId: activeRunId,
      } = optionRefs.current;
      const next = open(`${baseUrl}${withRunId(path, activeRunId)}`);
      stream = next;
      next.onopen = () => {
        if (!cancelled) {
          setStatus("open");
        }
      };
      next.onmessage = (ev) => {
        if (!cancelled) {
          appendFrame(ev.data);
        }
      };
      next.onerror = () => {
        if (cancelled) {
          return;
        }
        // Tear down the dropped stream and schedule a reconnect that first
        // rebuilds from the diary (Rebuild-R10.2) before re-subscribing.
        next.close();
        if (stream === next) {
          stream = null;
        }
        setStatus("reconnecting");
        reconnectTimer = setTimeout(() => {
          void reconnect();
        }, optionRefs.current.reconnectDelayMs);
      };
    };

    const reconnect = async (): Promise<void> => {
      if (cancelled) {
        return;
      }
      // Rebuild the feed from the trailing diary entries BEFORE resuming live
      // streaming. Merging by seq leaves already-rendered rows untouched and
      // backfills anything missed while disconnected.
      try {
        const trailing = await optionRefs.current.recoverFromDiary(
          `${baseUrl}${withRunId(optionRefs.current.diaryUrl, optionRefs.current.runId)}`,
        );
        if (!cancelled && trailing.length > 0) {
          setEvents((prev) => mergeEvents(prev, trailing));
        }
      } catch {
        // A failed recovery must not block resuming the live stream.
      }
      if (!cancelled) {
        subscribe();
      }
    };

    const start = async (): Promise<void> => {
      setStatus("connecting");
      try {
        baseUrl = await optionRefs.current.resolveBaseUrl();
      } catch {
        // The sidecar never became ready; surface a closed stream rather than
        // subscribing to an unresolved origin.
        if (!cancelled) {
          setStatus("closed");
        }
        return;
      }
      if (cancelled) {
        return;
      }
      subscribe();
    };

    void start();
    setEvents([]);

    return () => {
      cancelled = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }
      if (stream !== null) {
        stream.close();
        stream = null;
      }
      setStatus("closed");
    };
  }, [runId]);

  return { events, status };
}

export default useAgentStream;
