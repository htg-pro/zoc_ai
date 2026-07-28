import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import { useApp } from "@/lib/store";
import { activeRuns } from "./agent-runs";
import { AgentStreamContext } from "./agent-stream-context";
import {
  currentViewerContext,
  viewerEventsPath,
  viewerReplayPath,
  type ViewerContext,
} from "./share-session";
import useAgentStream, {
  type AgentEvent,
  type StreamStatus,
  type UseAgentStreamOptions,
  type UseAgentStreamResult,
} from "./useAgentStream";
import { useAgentRunLifecycle } from "./useAgentRunLifecycle";

type RunFeed = UseAgentStreamResult;

const viewerOrigin = async (): Promise<string> =>
  typeof window === "undefined" ? "" : window.location.origin;

function streamOptionsForViewer(context: ViewerContext): UseAgentStreamOptions {
  const eventsUrl = viewerEventsPath(context);
  const replayUrl = viewerReplayPath(context);
  return {
    ...(eventsUrl ? { eventsUrl } : {}),
    ...(replayUrl ? { diaryUrl: replayUrl } : {}),
    resolveBaseUrl: viewerOrigin,
  };
}

function RunStreamSubscription({
  runId,
  viewer,
  onUpdate,
}: {
  runId: string;
  viewer: ViewerContext;
  onUpdate: (runId: string, feed: RunFeed) => void;
}): null {
  const options = viewer.readOnly ? streamOptionsForViewer(viewer) : {};
  const { events, status } = useAgentStream({ ...options, runId, enabled: true });

  // A viewer consumes telemetry only. It must never commit staged edits,
  // mutate the host's run state, or emit local approval/audit side effects.
  useAgentRunLifecycle(events, !viewer.readOnly, runId, status);

  useEffect(() => {
    onUpdate(runId, { events, status });
  }, [events, onUpdate, runId, status]);

  return null;
}

function sameFeed(previous: RunFeed | undefined, next: RunFeed): boolean {
  if (!previous || previous.status !== next.status || previous.events.length !== next.events.length) {
    return false;
  }
  return previous.events.every((event, index) => {
    const candidate = next.events[index];
    return candidate !== undefined
      && event.type === candidate.type
      && event.seq === candidate.seq
      && event.runId === candidate.runId;
  });
}

function aggregateStatus(feeds: readonly RunFeed[], enabled: boolean): StreamStatus {
  if (!enabled) return "closed";
  if (feeds.some((feed) => feed.status === "open")) return "open";
  if (feeds.some((feed) => feed.status === "reconnecting")) return "reconnecting";
  if (feeds.some((feed) => feed.status === "connecting")) return "connecting";
  return "closed";
}

function eventTime(event: AgentEvent): number {
  const raw = "ts" in event ? event.ts : undefined;
  if (typeof raw !== "string") return 0;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Own all live Gateway telemetry subscriptions and expose one aggregate feed.
 * There is still one SSE implementation (`useAgentStream`), while each active
 * run gets an independent connection so starting/focusing a peer never detaches
 * or stalls an earlier run.
 */
export function AgentStreamProvider({ children }: { children: ReactNode }): JSX.Element {
  const currentRunId = useApp((state) => state.runId);
  const trackedRuns = useApp((state) => state.trackedRuns ?? []);
  const viewer = useMemo(currentViewerContext, []);
  const [feedsByRun, setFeedsByRun] = useState<Record<string, RunFeed>>({});

  const runIds = useMemo(() => {
    if (viewer.readOnly) return viewer.runId ? [viewer.runId] : [];
    const ids = activeRuns(trackedRuns).map((run) => run.runId);
    // Compatibility for a legacy/synthetic run that predates trackedRuns.
    if (ids.length === 0 && currentRunId) ids.push(currentRunId);
    return [...new Set(ids)];
  }, [currentRunId, trackedRuns, viewer.readOnly, viewer.runId]);

  const updateFeed = useCallback((runId: string, feed: RunFeed) => {
    setFeedsByRun((current) => {
      const previous = current[runId];
      if (sameFeed(previous, feed)) return current;
      return { ...current, [runId]: feed };
    });
  }, []);

  const value = useMemo<UseAgentStreamResult>(() => {
    // Keep completed feeds in the aggregate so their collapsed cards remain
    // inspectable after the live subscription unmounts.
    const feeds = Object.values(feedsByRun);
    const events = feeds
      .flatMap((feed) => feed.events)
      .sort((a, b) => eventTime(a) - eventTime(b));
    return {
      events,
      status: aggregateStatus(feeds, runIds.length > 0),
    };
  }, [feedsByRun, runIds.length]);

  return (
    <AgentStreamContext.Provider value={value}>
      {runIds.map((runId) => (
        <RunStreamSubscription
          key={runId}
          runId={runId}
          viewer={viewer}
          onUpdate={updateFeed}
        />
      ))}
      {children}
    </AgentStreamContext.Provider>
  );
}
