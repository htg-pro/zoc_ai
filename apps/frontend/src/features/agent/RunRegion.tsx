/**
 * RunRegion.tsx — the scrollable body (grid row 3) of the Agent_Panel.
 *
 * Renders both streams in a single scroll container:
 *  1. conversation (`chat`): user/assistant messages, tool calls and diffs
 *  2. live Gateway telemetry events from the single SSE client (`useAgentStream`),
 *     dispatched through the shared `ROW_COMPONENTS` registry in `rows.tsx`.
 */
import { Fragment, useEffect, useRef, useState } from "react";
import { Zap } from "lucide-react";
import type { Message } from "@zoc-studio/shared-types";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { useApp } from "@/lib/store";
import { EmptyState } from "./EmptyState";
import { MessageItem } from "./MessageItem";
import { ToolCallCard } from "./ToolCallCard";
import { DiffCard } from "./DiffCard";
import useAgentStream from "./useAgentStream";
import type { AgentEvent, TokenEvent, StreamErrorEvent } from "./useAgentStream";
import { buildRunTraces } from "./agent-trace";
import { RunTraceCard } from "./RunTraceCard";

function isTokenEvent(event: AgentEvent): event is TokenEvent {
  return event.type === "token";
}

function isStreamErrorEvent(event: AgentEvent): event is StreamErrorEvent {
  return event.type === "error";
}

function isBudgetEvent(event: AgentEvent): event is AgentEvents.BudgetEvent {
  return event.type === "budget";
}

export function RunRegion(): JSX.Element {
  const chat               = useApp((s) => s.chat);
  const agentMode          = useApp((s) => s.agentMode);
  const activeRunMode      = useApp((s) => s.activeRunMode);
  const runId              = useApp((s) => s.runId);
  const finishGatewayRun   = useApp((s) => s.finishGatewayRun);
  const updateRunBudget    = useApp((s) => s.updateRunBudget);
  const commitAskStreamMessage = useApp((s) => s.commitAskStreamMessage);
  const { events }         = useAgentStream({ runId, enabled: !!runId });

  const scrollRef          = useRef<HTMLDivElement>(null);
  const lastRunIdRef        = useRef<string | null>(null);
  const [retainedAgentEvents, setRetainedAgentEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    if (runId && runId !== lastRunIdRef.current) {
      lastRunIdRef.current = runId;
      setRetainedAgentEvents([]);
    }
  }, [runId]);

  useEffect(() => {
    if (runId && activeRunMode === "agent" && events.length > 0) {
      setRetainedAgentEvents(events);
    }
  }, [activeRunMode, events, runId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, events, retainedAgentEvents]);

  useEffect(() => {
    if (!runId) return;
    const latestBudget = [...events]
      .reverse()
      .find(
        (event): event is AgentEvents.BudgetEvent =>
          isBudgetEvent(event) && event.runId === runId,
      );
    if (latestBudget) updateRunBudget(latestBudget);
  }, [events, runId, updateRunBudget]);

  useEffect(() => {
    if (!runId) return;
    const terminal = events.find(
      (event) =>
        (event.type === "done" && event.runId === runId) ||
        (isTokenEvent(event) && event.runId === runId && event.done === true) ||
        (isStreamErrorEvent(event) && event.runId === runId),
    );
    if (terminal) {
      const effectiveMode = activeRunMode ?? agentMode;
      if (effectiveMode === "ask") {
        const askTokens = events.filter(
          (event): event is TokenEvent =>
            isTokenEvent(event) && event.runId === runId && !!event.text,
        );
        const askText = askTokens.map((event) => event.text).join("");
        commitAskStreamMessage(runId, askText, askTokens[0]?.ts);
      }
      finishGatewayRun(runId);
    }
  }, [activeRunMode, agentMode, commitAskStreamMessage, events, finishGatewayRun, runId]);

  const visibleEvents = runId ? events : retainedAgentEvents;
  const runTraces     = buildRunTraces(visibleEvents);
  const orphanErrors  = visibleEvents.filter(
    (event): event is StreamErrorEvent => isStreamErrorEvent(event) && !event.runId,
  );
  const empty = chat.length === 0 && visibleEvents.length === 0;

  if (empty) {
    const isAsk = (activeRunMode ?? agentMode) === "ask";
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <EmptyState
          icon={Zap}
          title={isAsk ? "Ask about your code" : "Start a task"}
          description={
            isAsk
              ? "Ask a question about your codebase — answers are read-only."
              : "Describe what you want to build or change and the agent will get to work."
          }
          bullets={[
            "Type a message below and press Enter to send.",
            "Use @ to attach files and / to run a command.",
          ]}
        />
      </div>
    );
  }

  const streamedAskText = events
    .filter(
      (event): event is TokenEvent =>
        (activeRunMode ?? agentMode) === "ask" &&
        isTokenEvent(event) &&
        event.runId === runId &&
        !!event.text,
    )
    .map((event) => event.text)
    .join("");

  const streamedAskMessage: Message | null = streamedAskText
    ? {
        id: `ask-stream-${runId}`,
        role: "assistant",
        content: streamedAskText,
        created_at:
          events.find((event) => isTokenEvent(event) && event.runId === runId)?.ts ??
          new Date().toISOString(),
      }
    : null;

  return (
    <div
      ref={scrollRef}
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4"
      role="log"
      aria-live="polite"
      aria-label="Agent conversation and run feed"
      data-testid="agent-run-region"
    >
      {chat.map((entry) => {
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

      {streamedAskMessage ? (
        <MessageItem key={streamedAskMessage.id} message={streamedAskMessage} />
      ) : null}

      {runTraces.map((trace) => (
        <Fragment key={trace.runId}>
          <RunTraceCard trace={trace} />
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
      ))}

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
