import { useEffect, useRef } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { useApp } from "@/lib/store";
import { ErrorCodes, isAuthError } from "@/lib/errors";
import type { RunPhase as TrackedRunPhase } from "./agent-runs";
import {
  cancelAgentEditBatch,
  commitAgentEditBatch,
} from "@/features/editor/agent-edit-bridge";
import { recordDecision } from "@/lib/trust";
import { stripReasoning } from "./reasoning";
import {
  isTerminalPhase,
  reduceRun,
  startRun,
  type RunPhase as LifecyclePhase,
  type RunRecord,
} from "./run-lifecycle";
import type { AgentMode } from "./gateway-client";
import type {
  AgentEvent,
  StreamErrorEvent,
  StreamStatus,
  TokenEvent,
} from "./useAgentStream";

function isTokenEvent(event: AgentEvent): event is TokenEvent {
  return event.type === "token";
}

function isStreamErrorEvent(event: AgentEvent): event is StreamErrorEvent {
  return event.type === "error";
}

function isBudgetEvent(event: AgentEvent): event is AgentEvents.BudgetEvent {
  return event.type === "budget";
}

function isPermissionEvent(event: AgentEvent): event is AgentEvents.PermissionEvent {
  return event.type === "permission";
}

/** How often the stall watchdog re-evaluates the run against the wall clock. */
const STALL_TICK_INTERVAL_MS = 5_000;

/** Map the lifecycle reducer's terminal phase onto the store's TrackedRun phase. */
function toTrackedPhase(phase: LifecyclePhase): TrackedRunPhase {
  switch (phase) {
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    // Retries exhausted / connection lost: its own terminal phase (R8.4).
    case "interrupted":
      return "interrupted";
    case "failed":
    default:
      return "failed";
  }
}

/** Per-run lifecycle bookkeeping, held across renders in a ref. */
interface LifecycleTracker {
  runId: string | null;
  record: RunRecord | null;
  processedSeq: number;
  finalized: boolean;
}

/**
 * Keep canonical run state synchronized with the one Gateway event stream.
 *
 * The run phase is derived by the pure `reduceRun` reducer (R8.1–R8.5) rather
 * than by independent `useEffect` scans that each re-derived terminal state from
 * the whole event array — which is why a stalled or disconnected run previously
 * had no representation. Events fold into a `RunRecord`; a stall watchdog feeds
 * the clock in as `tick` inputs; a dropped transport (`streamStatus`) folds in a
 * `disconnected` input. A terminal phase settles the run exactly once and, since
 * the run is then terminal, `terminalHeader` drops its occupancy banner (R8.6).
 */
export function useAgentRunLifecycle(
  events: readonly AgentEvent[],
  enabled = true,
  boundRunId?: string | null,
  streamStatus?: StreamStatus,
): void {
  const activeRunId = useApp((state) => state.runId);
  const runId = boundRunId === undefined ? activeRunId : boundRunId;
  const agentMode = useApp((state) => state.agentMode);
  const activeRunMode = useApp((state) => state.activeRunMode);
  const trackedMode = useApp(
    (state) => (state.trackedRuns ?? []).find((run) => run.runId === runId)?.mode,
  );
  const trackedStartedAt = useApp(
    (state) => (state.trackedRuns ?? []).find((run) => run.runId === runId)?.startedAt,
  );
  const finishGatewayRun = useApp((state) => state.finishGatewayRun);
  const updateRunBudget = useApp((state) => state.updateRunBudget);
  const setRunStage = useApp((state) => state.setRunStage);
  const setRunPhase = useApp((state) => state.setRunPhase);
  const commitAskStreamMessage = useApp((state) => state.commitAskStreamMessage);
  const markProviderInvalid = useApp((state) => state.markProviderInvalid);
  const selectedProvider = useApp((state) => state.selectedModel?.provider ?? "");

  const auditedPermissionEvents = useRef(new Set<string>());
  const processedEditLifecycleEvents = useRef(new Set<string>());
  const trackerRef = useRef<LifecycleTracker>({
    runId: null,
    record: null,
    processedSeq: -1,
    finalized: false,
  });

  useEffect(() => {
    if (!enabled) return;
    for (const event of events) {
      if (!isPermissionEvent(event)) continue;
      const key = `${event.runId}:${event.seq}`;
      if (auditedPermissionEvents.current.has(key)) continue;
      auditedPermissionEvents.current.add(key);
      recordDecision(
        {
          kind: event.kind,
          name: event.name,
          target: event.target ?? undefined,
        },
        { effect: event.effect, reason: event.reason },
        event.runId,
      );
    }
  }, [enabled, events]);

  useEffect(() => {
    if (!enabled) return;
    for (const event of events) {
      if (event.type !== "summary" && event.type !== "done" && !isStreamErrorEvent(event)) {
        continue;
      }
      const eventRunId = event.runId;
      if (!eventRunId) continue;
      const key = `${eventRunId}:${event.seq}:${event.type}`;
      if (processedEditLifecycleEvents.current.has(key)) continue;
      processedEditLifecycleEvents.current.add(key);
      if (event.type === "summary") commitAgentEditBatch(eventRunId);
      else cancelAgentEditBatch(eventRunId);
    }
  }, [enabled, events]);

  // R4.5/R13.x — an SSE `error` frame whose code/status is an auth rejection
  // marks ONLY the selected provider invalid so the picker can name it. Idempotent.
  useEffect(() => {
    if (!enabled || !selectedProvider) return;
    if (typeof markProviderInvalid !== "function") return;
    for (const event of events) {
      if (!isStreamErrorEvent(event)) continue;
      const code = (event as { code?: unknown }).code;
      const status = (event as { status?: unknown }).status;
      if (
        isAuthError({
          code: typeof code === "string" ? code : undefined,
          status: typeof status === "number" ? status : undefined,
        })
      ) {
        markProviderInvalid(selectedProvider);
        break;
      }
    }
  }, [enabled, events, markProviderInvalid, selectedProvider]);

  useEffect(() => {
    if (!enabled || !runId) return;
    const latestBudget = [...events]
      .reverse()
      .find(
        (event): event is AgentEvents.BudgetEvent =>
          isBudgetEvent(event) && event.runId === runId,
      );
    if (latestBudget) updateRunBudget(latestBudget);
  }, [enabled, events, runId, updateRunBudget]);

  // The run's lifecycle phase, folded from the event stream by `reduceRun`. This
  // replaces the former independent "latest event type" and "find terminal
  // frame" scans: one reducer owns the phase, so a settled run cannot reopen and
  // a stalled/reconnecting run is representable.
  useEffect(() => {
    if (!enabled || !runId) return;
    const tracker = trackerRef.current;
    if (tracker.runId !== runId) {
      tracker.runId = runId;
      tracker.record = null;
      tracker.processedSeq = -1;
      tracker.finalized = false;
    }
    const mode = (trackedMode ?? activeRunMode ?? agentMode) as AgentMode;
    if (!tracker.record) {
      tracker.record = startRun({
        runId,
        mode,
        startedAt: trackedStartedAt ?? Date.now(),
      });
    }

    const pending = events
      .filter((event) => event.runId === runId && event.seq > tracker.processedSeq)
      .slice()
      .sort((a, b) => a.seq - b.seq);

    let latestType: string | null = null;
    for (const event of pending) {
      tracker.processedSeq = Math.max(tracker.processedSeq, event.seq);
      const atMs = Date.now();
      const code = (event as { code?: unknown }).code;
      if (isStreamErrorEvent(event) && code === ErrorCodes.runCancelled) {
        // A terminal `error` frame coded `run_cancelled` is a stop, not a
        // failure — settle it as cancelled, matching the reducer's cancel path.
        tracker.record = reduceRun(tracker.record, { kind: "cancel-acknowledged", atMs });
      } else if (isTokenEvent(event) && event.done === true) {
        // The Ask stream terminates on a done-flagged token rather than a `done`
        // frame; fold in an equivalent terminal so the reducer settles the run.
        tracker.record = reduceRun(tracker.record, {
          kind: "event",
          event: { type: "done", seq: event.seq, runId, ts: event.ts, ok: true } as unknown as AgentEvent,
          atMs,
        });
      } else {
        tracker.record = reduceRun(tracker.record, { kind: "event", event, atMs });
      }
      if (typeof event.type === "string") latestType = event.type;
    }

    if (!isTerminalPhase(tracker.record.phase)) {
      // Keep the run's *real* last stage on the tracked run (not the transient
      // "stalled"/"reconnecting" words — those are the phase now, R8.3/R8.4).
      const stageLabel = tracker.record.stage ?? latestType;
      if (stageLabel && typeof setRunStage === "function") setRunStage(stageLabel, runId);
      const trackedPhase: TrackedRunPhase | null =
        tracker.record.phase === "stalled"
          ? "stalled"
          : tracker.record.phase === "reconnecting"
            ? "reconnecting"
            : tracker.record.phase === "running"
              ? "running"
              : null;
      if (trackedPhase && typeof setRunPhase === "function") setRunPhase(trackedPhase, runId);
    }

    if (isTerminalPhase(tracker.record.phase) && !tracker.finalized) {
      tracker.finalized = true;
      if (mode === "ask") {
        const askTokens = events.filter(
          (event): event is TokenEvent =>
            isTokenEvent(event) && event.runId === runId && Boolean(event.text),
        );
        const askText = askTokens.map((event) => event.text).join("");
        // Never persist a model's private scratchpad as the answer: a model that
        // ignores the "reasoning goes in the thinking channel" contract and emits
        // <think> inline would otherwise be stored, replayed, and shared verbatim.
        commitAskStreamMessage(runId, stripReasoning(askText), askTokens[0]?.ts);
      }
      finishGatewayRun(runId, toTrackedPhase(tracker.record.phase), {
        filesChanged: tracker.record.filesChanged,
        reason: tracker.record.outcomeReason,
      });
    }
  }, [
    activeRunMode,
    agentMode,
    commitAskStreamMessage,
    enabled,
    events,
    finishGatewayRun,
    runId,
    setRunStage,
    setRunPhase,
    trackedMode,
    trackedStartedAt,
  ]);

  // Stall watchdog (R8.3): the clock is an input to the reducer, fed as `tick`
  // inputs so a run with no frame for `STALL_THRESHOLD_MS` becomes `stalled`.
  useEffect(() => {
    if (!enabled || !runId) return;
    const timer = setInterval(() => {
      const tracker = trackerRef.current;
      if (!tracker.record || tracker.finalized || tracker.runId !== runId) return;
      const before = tracker.record.phase;
      tracker.record = reduceRun(tracker.record, { kind: "tick", atMs: Date.now() });
      if (
        tracker.record.phase !== before &&
        tracker.record.phase === "stalled" &&
        typeof setRunPhase === "function"
      ) {
        setRunPhase("stalled", runId);
      }
    }, STALL_TICK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, runId, setRunPhase]);

  // Reconnection (R8.4): a dropped SSE transport moves the run to reconnecting;
  // a subsequent live frame folds the run back to running via `reduceRun`. When
  // the transport's bounded reconnect budget is exhausted it reports
  // `interrupted`, which terminalizes the run as interrupted and settles it once.
  useEffect(() => {
    if (!enabled || !runId) return;
    if (streamStatus !== "reconnecting" && streamStatus !== "interrupted") return;
    const tracker = trackerRef.current;
    if (!tracker.record || tracker.finalized || tracker.runId !== runId) return;
    const atMs = Date.now();
    if (streamStatus === "reconnecting") {
      tracker.record = reduceRun(tracker.record, { kind: "disconnected", atMs });
      if (typeof setRunPhase === "function") setRunPhase("reconnecting", runId);
      return;
    }
    // streamStatus === "interrupted": retries exhausted — settle the run.
    tracker.record = reduceRun(tracker.record, { kind: "reconnect-failed", atMs });
    if (isTerminalPhase(tracker.record.phase)) {
      tracker.finalized = true;
      finishGatewayRun(runId, toTrackedPhase(tracker.record.phase), {
        filesChanged: tracker.record.filesChanged,
        reason:
          tracker.record.outcomeReason ?? "The connection to the agent was lost.",
      });
    }
  }, [enabled, runId, streamStatus, setRunPhase, finishGatewayRun]);
}
