/**
 * RunRegion.tsx — conversation plus stacked concurrent Gateway run cards.
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Zap } from "lucide-react";
import type { Message } from "@zoc-studio/shared-types";

import { useApp } from "@/lib/store";
import { EmptyState } from "./EmptyState";
import { MessageItem } from "./MessageItem";
import { ToolCallCard } from "./ToolCallCard";
import { DiffCard } from "./DiffCard";
import useAgentStream from "./useAgentStream";
import { useAgentStreamContext } from "./agent-stream-context";
import { useAgentRunLifecycle } from "./useAgentRunLifecycle";
import type { AgentEvent, TokenEvent, StreamErrorEvent } from "./useAgentStream";
import { buildRunTraces, type RunTrace } from "./agent-trace";
import { isTerminal, orderRuns, type TrackedRun } from "./agent-runs";
import { currentViewerContext } from "./share-session";
import { RunTraceCard } from "./RunTraceCard";

function isTokenEvent(event: AgentEvent): event is TokenEvent {
  return event.type === "token";
}

function isStreamErrorEvent(event: AgentEvent): event is StreamErrorEvent {
  return event.type === "error";
}

function placeholderTrace(run: TrackedRun): RunTrace {
  return {
    runId: run.runId,
    startedSeq: Number.MAX_SAFE_INTEGER,
    lastSeq: Number.MAX_SAFE_INTEGER,
    status:
      run.phase === "failed" || run.phase === "cancelled"
        ? "failed"
        : run.phase === "done"
          ? "done"
          : run.phase === "paused"
            ? "paused"
            : "running",
    stage: run.stage ?? "starting",
    prompt: run.title,
    planItems: [],
    activities: [],
    ...(run.phase === "cancelled" ? { doneReason: "cancelled" } : {}),
  };
}

function askMessages(
  events: readonly AgentEvent[],
  hiddenFinalIds: ReadonlySet<string>,
): Map<string, Message> {
  const grouped = new Map<string, TokenEvent[]>();
  for (const event of events) {
    if (!isTokenEvent(event) || !event.runId || !event.text) continue;
    const current = grouped.get(event.runId) ?? [];
    current.push(event);
    grouped.set(event.runId, current);
  }
  const messages = new Map<string, Message>();
  for (const [runId, tokens] of grouped) {
    if (hiddenFinalIds.has(`ask-final-${runId}`)) continue;
    tokens.sort((a, b) => a.seq - b.seq);
    messages.set(runId, {
      id: `ask-stream-${runId}`,
      role: "assistant",
      content: tokens.map((event) => event.text).join(""),
      created_at: tokens[0]?.ts ?? new Date().toISOString(),
    });
  }
  return messages;
}

export function RunRegion(): JSX.Element {
  const chat = useApp((state) => state.chat);
  const agentMode = useApp((state) => state.agentMode);
  const activeRunMode = useApp((state) => state.activeRunMode);
  const runId = useApp((state) => state.runId);
  const trackedRuns = useApp((state) => state.trackedRuns ?? []);
  const focusedRunId = useApp((state) => state.focusedRunId ?? null);
  const focusRun = useApp((state) => state.focusRun);
  const cancelRunById = useApp((state) => state.cancelRunById);
  const viewer = useMemo(currentViewerContext, []);
  const sharedStream = useAgentStreamContext();
  const fallbackStream = useAgentStream({
    runId,
    enabled: Boolean(runId) && sharedStream === null,
  });
  const events = sharedStream?.events ?? fallbackStream.events;
  useAgentRunLifecycle(events, sharedStream === null && !viewer.readOnly, runId);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [retainedAgentEvents, setRetainedAgentEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    if (!viewer.readOnly && events.length > 0) setRetainedAgentEvents(events);
  }, [events, viewer.readOnly]);

  const visibleEvents = useMemo(() => {
    const source = events.length > 0 ? events : retainedAgentEvents;
    return viewer.runId
      ? source.filter((event) => event.runId === viewer.runId)
      : source;
  }, [events, retainedAgentEvents, viewer.runId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, visibleEvents, focusedRunId]);

  const traces = buildRunTraces(visibleEvents);
  const tracesByRun = new Map(traces.map((trace) => [trace.runId, trace]));
  const orderedTracked = orderRuns(trackedRuns);
  if (focusedRunId) {
    const index = orderedTracked.findIndex((run) => run.runId === focusedRunId);
    if (index > 0) orderedTracked.unshift(...orderedTracked.splice(index, 1));
  }

  const cards: Array<{ trace: RunTrace; run?: TrackedRun }> = orderedTracked.map((run) => ({
    run,
    trace: tracesByRun.get(run.runId) ?? placeholderTrace(run),
  }));
  for (const trace of traces) {
    if (!trackedRuns.some((run) => run.runId === trace.runId)) cards.push({ trace });
  }

  // Ask mode has no structured trace events. Synthesize a lightweight card
  // from its token-only feed so LAN viewers and concurrent Ask runs remain
  // visible and focusable like Agent runs.
  const representedRunIds = new Set(cards.map((card) => card.trace.runId));
  for (const eventRunId of new Set(
    visibleEvents.map((event) => event.runId).filter((id): id is string => Boolean(id)),
  )) {
    if (representedRunIds.has(eventRunId)) continue;
    const runEvents = visibleEvents.filter((event) => event.runId === eventRunId);
    const failed = runEvents.some(isStreamErrorEvent);
    const done = runEvents.some(
      (event) => isTokenEvent(event) && event.done === true,
    );
    const firstTs = runEvents
      .map((event) => ("ts" in event && typeof event.ts === "string" ? Date.parse(event.ts) : 0))
      .find((timestamp) => Number.isFinite(timestamp) && timestamp > 0) ?? Date.now();
    const synthetic: TrackedRun = {
      runId: eventRunId,
      mode: "ask",
      phase: failed ? "failed" : done ? "done" : "running",
      title: "Shared Ask run",
      startedAt: firstTs,
      ...(done || failed ? { endedAt: Date.now() } : {}),
    };
    cards.push({ run: synthetic, trace: placeholderTrace(synthetic) });
  }

  const renderedChat = viewer.readOnly ? [] : chat;
  const finalAskIds = new Set(renderedChat.map((entry) => entry.id));
  const streamedAsk = askMessages(visibleEvents, finalAskIds);
  const orphanErrors = visibleEvents.filter(
    (event): event is StreamErrorEvent => isStreamErrorEvent(event) && !event.runId,
  );
  const empty = renderedChat.length === 0 && cards.length === 0 && orphanErrors.length === 0;

  if (empty) {
    const isAsk = (activeRunMode ?? agentMode) === "ask";
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <EmptyState
          icon={Zap}
          title={viewer.readOnly ? "Waiting for the shared run" : isAsk ? "Ask about your code" : "Start a task"}
          description={
            viewer.readOnly
              ? "Live events from the host will appear here."
              : isAsk
                ? "Ask a question about your codebase — answers are read-only."
                : "Describe what you want to build or change and the agent will get to work."
          }
          bullets={viewer.readOnly ? [] : [
            "Type a message below and press Enter to send.",
            "Use @ to attach files and / to run a command.",
          ]}
        />
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4"
      role="log"
      aria-live="polite"
      aria-label="Agent conversation and run feed"
      data-testid="agent-run-region"
    >
      {renderedChat.map((entry) => {
        if (entry.kind === "message" && entry.message) {
          return <MessageItem key={entry.id} message={entry.message} />;
        }
        if (entry.kind === "tool_call" && entry.toolCall) {
          return <ToolCallCard key={entry.id} call={entry.toolCall} />;
        }
        if (entry.kind === "diff" && entry.diff) {
          return <DiffCard key={entry.id} patch={entry.diff} />;
        }
        return null;
      })}

      {cards.map(({ trace, run }) => {
        const focused = trace.runId === focusedRunId || (viewer.readOnly && cards.length === 1);
        return (
          <Fragment key={trace.runId}>
            <RunTraceCard
              trace={trace}
              run={run}
              focused={focused}
              collapsed={Boolean(run && isTerminal(run) && !focused)}
              readOnly={viewer.readOnly}
              onFocus={viewer.readOnly ? undefined : focusRun}
              onStop={viewer.readOnly ? undefined : cancelRunById}
            />
            {streamedAsk.get(trace.runId) ? (
              <MessageItem message={streamedAsk.get(trace.runId)!} />
            ) : null}
            {trace.summary ? (
              <MessageItem
                message={{
                  id: `agent-summary-${trace.runId}`,
                  role: "assistant",
                  content: trace.summary,
                  created_at: new Date().toISOString(),
                }}
              />
            ) : null}
          </Fragment>
        );
      })}

      {orphanErrors.map((event) => (
        <div
          key={`err-${event.seq}`}
          className="animate-fade-row rounded-xl border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/8 px-3 py-2.5 text-[12.5px] leading-snug text-[var(--zoc-error)]"
          data-event-type="error"
        >
          {event.message}
        </div>
      ))}
    </div>
  );
}

export default RunRegion;
