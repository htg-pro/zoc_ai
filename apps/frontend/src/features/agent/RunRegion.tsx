/**
 * RunRegion.tsx — conversation plus stacked concurrent Gateway run cards.
 *
 * The run feed flows through the single seam: SSE events → `normalizeEvents` →
 * `FeedRow[]` → `assembleRunCards` (grouped by runId) → `RunCardView`, which
 * renders each row through the closed `renderRow` registry. Raw `AgentEvent`
 * values never reach a renderer (R9.6).
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Zap } from "lucide-react";

import { useApp } from "@/lib/store";
import { fsReadText, fsStat } from "@/lib/tauri-bridge";
import { EmptyState } from "./EmptyState";
import { MessageItem } from "./MessageItem";
import { ToolCallCard } from "./ToolCallCard";
import { DiffCard } from "./DiffCard";
import useAgentStream from "./useAgentStream";
import { useAgentStreamContext } from "./agent-stream-context";
import { useAgentRunLifecycle } from "./useAgentRunLifecycle";
import type { AgentEvent } from "./useAgentStream";
import { normalizeEvents, type NormalizeContext } from "./normalize";
import { assembleRunCards } from "./run-cards";
import { RunCardView, isCardCollapsed } from "./RunCardView";
import { scrollDecision } from "./scroll-decision";
import { sha256Hex, type FileProbe } from "./diff-staleness";
import { currentViewerContext } from "./share-session";

/**
 * Production file probe for diff staleness (R12.7): existence via `fsStat`, and
 * the current content's SHA-256 via `fsReadText` + Web Crypto. Returns null when
 * the file can't be read (no desktop runtime), which is treated as "unknown"
 * (not stale) rather than a false alarm.
 */
async function probeWorkspaceFile(path: string): Promise<FileProbe | null> {
  try {
    const stat = await fsStat(path);
    if (stat && !stat.exists) return { exists: false, sha256: null };
    const content = await fsReadText(path);
    if (content === null) return null;
    return { exists: true, sha256: await sha256Hex(content) };
  } catch {
    return null;
  }
}

export function RunRegion(): JSX.Element {
  const chat = useApp((state) => state.chat);
  const agentMode = useApp((state) => state.agentMode);
  const activeRunMode = useApp((state) => state.activeRunMode);
  const runId = useApp((state) => state.runId);
  const boundMessageId = useApp(
    (state) => (state as { boundMessageId?: string | null }).boundMessageId ?? null,
  );
  const trackedRuns = useApp((state) => state.trackedRuns ?? []);
  const focusedRunId = useApp((state) => state.focusedRunId ?? null);
  const focusRun = useApp((state) => state.focusRun);
  const cancelRunById = useApp((state) => state.cancelRunById);
  const requestComposerSubmit = useApp((state) => state.requestComposerSubmit);
  const viewer = useMemo(currentViewerContext, []);
  const sharedStream = useAgentStreamContext();
  const fallbackStream = useAgentStream({
    runId,
    enabled: Boolean(runId) && sharedStream === null,
  });
  const events = sharedStream?.events ?? fallbackStream.events;
  const streamStatus = sharedStream?.status ?? fallbackStream.status;
  useAgentRunLifecycle(
    events,
    sharedStream === null && !viewer.readOnly,
    runId,
    streamStatus,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const distanceRef = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const [retainedAgentEvents, setRetainedAgentEvents] = useState<AgentEvent[]>([]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    distanceRef.current = el.scrollHeight - el.scrollTop - el.clientHeight;
    setShowJump(
      scrollDecision({ distanceFromBottomPx: distanceRef.current, newRowArrived: false })
        .showJumpToLatest,
    );
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    distanceRef.current = 0;
    setShowJump(false);
  };

  useEffect(() => {
    if (!viewer.readOnly && events.length > 0) setRetainedAgentEvents(events);
  }, [events, viewer.readOnly]);

  const visibleEvents = useMemo(() => {
    const source = events.length > 0 ? events : retainedAgentEvents;
    return viewer.runId ? source.filter((event) => event.runId === viewer.runId) : source;
  }, [events, retainedAgentEvents, viewer.runId]);

  // The single seam: events → FeedRow[]. Deterministic in seq order.
  const rows = useMemo(() => {
    const ctx: NormalizeContext = {
      activeRunId: viewer.runId ?? runId ?? null,
      boundMessageId,
      highestSeq: -1,
    };
    return normalizeEvents(visibleEvents, ctx).rows;
  }, [visibleEvents, viewer.runId, runId, boundMessageId]);

  const cards = useMemo(
    () => assembleRunCards({ rows, trackedRuns, focusedRunId }),
    [rows, trackedRuns, focusedRunId],
  );

  // Autoscroll follows the newest row only while the user is at the bottom
  // (R18.4/R18.5); once they scroll up it is suppressed and jump-to-latest is
  // offered instead. `distanceRef` holds the distance observed before this
  // content arrived, so growing content does not itself count as scrolling away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (
      scrollDecision({ distanceFromBottomPx: distanceRef.current, newRowArrived: true }).autoScroll
    ) {
      el.scrollTop = el.scrollHeight;
      distanceRef.current = 0;
      setShowJump(false);
    }
  }, [chat, rows, focusedRunId]);

  const renderedChat = viewer.readOnly ? [] : chat;
  // A run whose final answer has been persisted into the transcript must not
  // also render as a live card, or the answer appears twice (R18.7).
  const persistedRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of renderedChat) {
      if (entry.id.startsWith("ask-final-")) ids.add(entry.id.slice("ask-final-".length));
      if (entry.id.startsWith("agent-summary-")) ids.add(entry.id.slice("agent-summary-".length));
    }
    return ids;
  }, [renderedChat]);
  const visibleCards = useMemo(
    () => cards.filter((card) => !persistedRunIds.has(card.runId)),
    [cards, persistedRunIds],
  );
  const empty = renderedChat.length === 0 && visibleCards.length === 0;

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
          bullets={
            viewer.readOnly
              ? []
              : [
                  "Type a message below and press Enter to send.",
                  "Use @ to attach files and / to run a command.",
                ]
          }
        />
      </div>
    );
  }

  return (
    <div className="relative h-full min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-4"
        role="region"
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

        {visibleCards.map((card) => {
          const focused =
            card.runId === focusedRunId || (viewer.readOnly && visibleCards.length === 1);
          const retryPrompt = card.run?.prompt;
          const retryMessageId = card.run?.messageId ?? null;
          return (
            <Fragment key={card.runId}>
              <RunCardView
                card={card}
                focused={focused}
                collapsed={isCardCollapsed(card.run, focused)}
                readOnly={viewer.readOnly}
                onFocus={viewer.readOnly ? undefined : focusRun}
                onStop={viewer.readOnly ? undefined : cancelRunById}
                onRetry={
                  viewer.readOnly || !retryPrompt
                    ? undefined
                    : () => {
                        requestComposerSubmit(retryPrompt, {
                          reuseMessageId: retryMessageId,
                        });
                      }
                }
                onSubmitPrompt={
                  viewer.readOnly ? undefined : (prompt) => requestComposerSubmit(prompt)
                }
                probeFile={viewer.readOnly ? undefined : probeWorkspaceFile}
                onRegenerateDiff={
                  viewer.readOnly
                    ? undefined
                    : (_runId, path) =>
                        requestComposerSubmit(`Regenerate the proposed changes for ${path}.`)
                }
              />
            </Fragment>
          );
        })}
      </div>

      {showJump && (
        <button
          type="button"
          onClick={jumpToLatest}
          data-testid="jump-to-latest"
          className="zoc-focus-ring absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1 rounded-full border border-[#26262B] bg-[#15151A] px-3 py-1 text-[11px] text-[#D4D4D8] shadow-md"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </button>
      )}
    </div>
  );
}

export default RunRegion;
