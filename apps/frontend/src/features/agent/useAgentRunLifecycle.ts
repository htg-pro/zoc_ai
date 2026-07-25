import { useEffect, useRef } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { useApp } from "@/lib/store";
import { ErrorCodes } from "@/lib/errors";
import type { RunPhase } from "./agent-runs";
import {
  cancelAgentEditBatch,
  commitAgentEditBatch,
} from "@/features/editor/agent-edit-bridge";
import { recordDecision } from "@/lib/trust";
import type { AgentEvent, StreamErrorEvent, TokenEvent } from "./useAgentStream";

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
/** Keep canonical run state synchronized with the one Gateway event stream. */
export function useAgentRunLifecycle(
  events: readonly AgentEvent[],
  enabled = true,
  boundRunId?: string | null,
): void {
  const activeRunId = useApp((state) => state.runId);
  const runId = boundRunId === undefined ? activeRunId : boundRunId;
  const agentMode = useApp((state) => state.agentMode);
  const activeRunMode = useApp((state) => state.activeRunMode);
  const trackedMode = useApp(
    (state) => (state.trackedRuns ?? []).find((run) => run.runId === runId)?.mode,
  );
  const finishGatewayRun = useApp((state) => state.finishGatewayRun);
  const updateRunBudget = useApp((state) => state.updateRunBudget);
  const setRunStage = useApp((state) => state.setRunStage);
  const commitAskStreamMessage = useApp((state) => state.commitAskStreamMessage);

  const auditedPermissionEvents = useRef(new Set<string>());
  const processedEditLifecycleEvents = useRef(new Set<string>());

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

  // Remember how far the run got. The event *type* is a fixed enum, so this is
  // safe to report as a telemetry dimension (§11.2). The setter is treated as
  // optional: stage tracking is telemetry-only, so a store that does not provide
  // it (e.g. a narrow test double) must not break the run lifecycle.
  useEffect(() => {
    if (!enabled || !runId || typeof setRunStage !== "function") return;
    const latest = [...events].reverse().find((event) => event.runId === runId);
    if (latest?.type) setRunStage(latest.type, runId);
  }, [enabled, events, runId, setRunStage]);

  useEffect(() => {
    if (!enabled || !runId) return;
    const terminal = events.find(
      (event) =>
        (event.type === "done" && event.runId === runId) ||
        (isTokenEvent(event) && event.runId === runId && event.done === true) ||
        (isStreamErrorEvent(event) && event.runId === runId),
    );
    if (!terminal) return;

    const effectiveMode = trackedMode ?? activeRunMode ?? agentMode;
    if (effectiveMode === "ask") {
      const askTokens = events.filter(
        (event): event is TokenEvent =>
          isTokenEvent(event) && event.runId === runId && Boolean(event.text),
      );
      const askText = askTokens.map((event) => event.text).join("");
      commitAskStreamMessage(runId, askText, askTokens[0]?.ts);
    }
    // A terminal `error` frame coded `run_cancelled` is the gateway reporting a
    // stop, not a failure — the run must read "Stopped", not "Failed". This
    // matters when the stop did not originate in this window (another client, or
    // a cancel that only the backend knows about).
    const terminalCode = (terminal as { code?: unknown }).code;
    const phase: RunPhase =
      terminalCode === ErrorCodes.runCancelled
        ? "cancelled"
        : isStreamErrorEvent(terminal) || (terminal.type === "done" && terminal.ok === false)
          ? "failed"
          : "done";
    finishGatewayRun(runId, phase);
  }, [
    activeRunMode,
    agentMode,
    commitAskStreamMessage,
    enabled,
    events,
    finishGatewayRun,
    runId,
    trackedMode,
  ]);
}
