/**
 * RunRegion.tsx — the scrollable body (grid row 3) of the Agent_Panel.
 *
 * The panel previously rendered ONLY the Gateway SSE telemetry feed
 * (`AgentRunFeed`), whose eight typed Event_Rows (intent, thinking, read-files,
 * edit-file, command, summary, approval, done) do NOT include a conversation
 * message. As a result the user's own messages — and the assistant's text
 * replies — were written to the store's `chat` array but never displayed, so
 * typing "hi" appeared to do nothing.
 *
 * RunRegion fixes that by rendering BOTH streams in a single scroll container:
 *  1. the conversation (`chat`): user/assistant messages, tool calls and diffs,
 *  2. the live Gateway telemetry events from the single SSE client
 *     (`useAgentStream`), dispatched through the shared `ROW_COMPONENTS`
 *     registry in `rows.tsx` (still the single source of truth for row
 *     selection and the unrecognized-event guard).
 *
 * It auto-scrolls to the newest content so a sent message is always visible.
 */
import { useEffect, useRef } from "react";
import { MessageSquare } from "lucide-react";
import type { Message } from "@zoc-studio/shared-types";

import { useApp } from "@/lib/store";
import { EmptyState } from "./EmptyState";
import { MessageItem } from "./MessageItem";
import { ToolCallCard } from "./ToolCallCard";
import { DiffCard } from "./DiffCard";
import useAgentStream from "./useAgentStream";
import { ROW_COMPONENTS, isRecognizedEvent } from "./rows";
import type { AgentEvent, TokenEvent, StreamErrorEvent } from "./useAgentStream";

function isTokenEvent(event: AgentEvent): event is TokenEvent {
  return event.type === "token";
}

function isStreamErrorEvent(event: AgentEvent): event is StreamErrorEvent {
  return event.type === "error";
}

export function RunRegion(): JSX.Element {
  const chat = useApp((s) => s.chat);
  const agentMode = useApp((s) => s.agentMode);
  const runId = useApp((s) => s.runId);
  const finishGatewayRun = useApp((s) => s.finishGatewayRun);
  const { events } = useAgentStream({ runId, enabled: !!runId });

  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the newest message/event in view as the conversation grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat, events]);

  useEffect(() => {
    if (!runId) return;
    const terminal = events.find(
      (event) =>
        (event.type === "done" && event.runId === runId) ||
        (isTokenEvent(event) && event.runId === runId && event.done === true) ||
        (isStreamErrorEvent(event) && event.runId === runId),
    );
    if (terminal) {
      finishGatewayRun(runId);
    }
  }, [events, finishGatewayRun, runId]);

  const empty = chat.length === 0 && events.length === 0;
  if (empty) {
    const isAsk = agentMode === "ask";
    return (
      <div className="h-full min-h-0 overflow-y-auto">
        <EmptyState
          icon={MessageSquare}
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
        isTokenEvent(event) && event.runId === runId && !!event.text,
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
      className="agent-run-region flex h-full min-h-0 flex-col gap-2 overflow-y-auto px-3 py-3"
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

      {events.map((event) => {
        if (isTokenEvent(event)) {
          return null;
        }
        if (isStreamErrorEvent(event)) {
          return (
            <div
              key={`err-${event.seq}`}
              className="feed-item rounded-md border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-2.5 py-1.5 text-[13px] leading-snug text-[var(--zoc-error)]"
              data-event-type="error"
            >
              {event.message}
            </div>
          );
        }
        // Unrecognized event types are discarded without altering the feed (R3.5).
        if (!isRecognizedEvent(event)) {
          return null;
        }
        const Row = ROW_COMPONENTS[event.type];
        return (
          <div key={`evt-${event.seq}`} className="feed-item">
            <Row event={event} />
          </div>
        );
      })}
    </div>
  );
}

export default RunRegion;
