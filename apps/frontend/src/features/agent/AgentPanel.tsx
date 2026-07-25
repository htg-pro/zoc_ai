import { Component, useState, useEffect, useMemo, type ErrorInfo, type ReactNode } from "react";
import { FilePenLine, Pause, Play, Square, Zap } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format-elapsed";
import { controlAvailability } from "@/lib/run-machine";
import { AgentMenu } from "./AgentMenu";
import { AgentCrashBanner } from "./AgentCrashBanner";
import { AgentRunSwitcher } from "./AgentRunSwitcher";
import { RunRegion } from "./RunRegion";
import { Composer } from "./Composer";
import { ContextBar } from "./ContextBar";
import { ContextLimitDialog } from "./ContextLimitDialog";
import { ModelPicker } from "./ModelPicker";
import { ViewerBanner } from "./ShareSessionDialog";
import { TokenBudgetMeter } from "./TokenBudgetMeter";
import { activeRuns, isTerminal } from "./agent-runs";
import { currentViewerContext } from "./share-session";

export function AgentPanel() {
  const contextStatus   = useApp((s) => s.contextStatus);
  const streaming       = useApp((s) => s.streaming);
  const agentMode       = useApp((s) => s.agentMode);
  const activeRunMode   = useApp((s) => s.activeRunMode);
  const reviewRunning   = useApp((s) => s.reviewRunning);
  const testRunning     = useApp((s) => s.testGenRunning || s.testRunRunning);
  const cancelStream    = useApp((s) => s.cancelStream);
  const cancelRunById   = useApp((s) => s.cancelRunById);
  const selectedModel   = useApp((s) => s.selectedModel);
  const autonomy        = useApp((s) => s.autonomy);
  const agentPaused     = useApp((s) => s.agentPaused);
  const runBudget       = useApp((s) => s.runBudget);
  const pauseAgent      = useApp((s) => s.pauseAgent);
  const resumeAgent     = useApp((s) => s.resumeAgent);
  const workspaceRoot    = useApp((s) => s.workspaceRoot);
  const openInstructions = useApp((s) => s.openProjectInstructions);
  const trackedRuns       = useApp((s) => s.trackedRuns ?? []);
  const focusedRunId      = useApp((s) => s.focusedRunId ?? null);
  const maxConcurrentRuns = useApp((s) => s.maxConcurrentRuns ?? 3);
  const focusRun          = useApp((s) => s.focusRun);
  const viewer             = useMemo(currentViewerContext, []);
  const activeTrackedRuns  = activeRuns(trackedRuns);
  const focusedRun         = trackedRuns.find((run) => run.runId === focusedRunId)
    ?? activeTrackedRuns[activeTrackedRuns.length - 1];
  const runActive          = activeTrackedRuns.length > 0
    || (trackedRuns.length === 0 && streaming)
    || reviewRunning
    || testRunning;
  const stopRunId          = focusedRun && !isTerminal(focusedRun)
    ? focusedRun.runId
    : activeTrackedRuns[activeTrackedRuns.length - 1]?.runId;
  const [showContextLimit, setShowContextLimit] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const phase    = runActive ? (agentPaused ? "paused" : "running") : "idle";
  const controls = controlAvailability(phase);

  useEffect(() => {
    if (!runActive) { setElapsedMs(0); return; }
    const start = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => setElapsedMs(Date.now() - start), 1000);
    return () => clearInterval(timer);
  }, [runActive]);

  const elapsedTime  = formatElapsed(elapsedMs);
  const displayMode  = focusedRun?.mode ?? (runActive ? activeRunMode ?? agentMode : agentMode);
  const isAsk        = displayMode === "ask";
  const statusText   = viewer.readOnly
    ? "Watching…"
    : agentPaused
      ? "Paused"
      : isAsk
        ? "Answering…"
        : "Building…";

  return (
    <div
      className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-[#0C0C10]"
      data-testid="agent-panel"
    >
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="row-start-1 shrink-0 border-b border-[#1A1A1F] bg-[#0C0C10]">
        <ViewerBanner />
        {!viewer.readOnly && <AgentCrashBanner />}
        <div className="flex min-h-[48px] items-center gap-3 px-3.5 py-2">
          {/* Brand mark */}
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#3B1F7C] to-[#1A0E3A] border border-[#7C3AED]/30 shadow-[0_0_12px_rgba(124,58,237,0.25)]">
              <Zap className="h-3.5 w-3.5 text-[#9B6AF1]" />
            </span>
            <div className="min-w-0">
              <div className="text-[13px] font-semibold text-[#FAFAFA] leading-tight">
                Zoc
                <span className={cn("font-semibold", isAsk ? "text-[#60a5fa]" : "text-[#9B6AF1]")}>
                  {isAsk ? " Ask" : " Agent"}
                </span>
              </div>
              <div className="text-[10px] text-[#52525B] leading-tight mt-0.5">
                {isAsk ? "Read-only answers" : "Autonomous editing"}
              </div>
            </div>
          </div>

          <div className="ml-auto flex items-center gap-2 shrink-0">
            {!viewer.readOnly && <button
              type="button"
              onClick={() => void openInstructions()}
              disabled={!workspaceRoot}
              className="inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-[10px] font-medium text-[#71717A] transition-colors hover:bg-[#17171C] hover:text-[#C8C8CE] disabled:cursor-not-allowed disabled:opacity-40"
              title={workspaceRoot ? "Open .zoc/instructions.md" : "Open a workspace first"}
            >
              <FilePenLine className="h-3 w-3 shrink-0" />
              <span>Edit instructions</span>
            </button>}

            {runActive || viewer.readOnly ? (
              /* ── Live status pill ── */
              <div className="flex items-center gap-2 rounded-full border border-[#26262B] bg-[#15151A] px-2.5 py-1">
                <span className="relative flex h-2 w-2 shrink-0">
                  {!agentPaused && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#9B6AF1] opacity-50" />
                  )}
                  <span
                    className={cn(
                      "relative inline-flex h-2 w-2 rounded-full",
                      agentPaused ? "bg-[#71717A]" : "bg-[#9B6AF1]",
                    )}
                  />
                </span>
                <span className="text-[11px] font-medium text-[#C8C8CE]">{statusText}</span>
                <span className="font-mono text-[11px] text-[#52525B]">{elapsedTime}</span>
              </div>
            ) : (
              <>
                <span className="inline-flex h-5 items-center rounded-full border border-[#1E1E23] bg-[#141419] px-2 font-mono text-[10px] text-[#52525B]">
                  idle
                </span>
                {!viewer.readOnly && <ModelPicker />}
              </>
            )}

            <AgentRunSwitcher
              runs={trackedRuns}
              focusedRunId={focusedRunId}
              maxConcurrentRuns={maxConcurrentRuns}
              onFocus={(id) => focusRun(id)}
              onStop={viewer.readOnly ? undefined : (id) => void cancelRunById(id)}
            />
            {!viewer.readOnly && <AgentMenu />}
          </div>
        </div>

        {/* ── Run controls (visible only while active) ── */}
        {runActive && !viewer.readOnly && (
          <div className="flex items-center gap-2 px-3.5 pb-2.5 border-t border-[#1A1A1F]/80 pt-2">
            <button
              type="button"
              onClick={() => (agentPaused ? resumeAgent() : pauseAgent())}
              disabled={agentPaused ? !controls.resume : !controls.pause}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-[#26262B] bg-[#15151A] text-[#71717A] transition-colors hover:bg-[#1E1E23] hover:text-[#A1A1AA] disabled:pointer-events-none disabled:opacity-40"
              title={agentPaused ? "Resume run" : "Pause run"}
            >
              {agentPaused
                ? <Play className="h-3 w-3 fill-current text-[#9B6AF1]" />
                : <Pause className="h-3 w-3 fill-current" />}
            </button>

            <button
              type="button"
              onClick={() => stopRunId ? void cancelRunById(stopRunId) : cancelStream()}
              disabled={!controls.stop || (!stopRunId && !streaming)}
              className="flex h-6 w-6 items-center justify-center rounded-md border border-[#f87171]/30 bg-[#f87171]/10 text-[#f87171] transition-colors hover:bg-[#f87171]/20 disabled:pointer-events-none disabled:opacity-40"
              title="Stop run"
            >
              <Square className="h-2.5 w-2.5 fill-current" />
            </button>

            {/* Autonomy badge */}
            <span
              aria-label={`Autonomy level: ${autonomy}`}
              className="flex items-center gap-1.5 rounded-md border border-[#26262B] bg-[#15151A] px-2 py-0.5"
              title={`Autonomy: ${autonomy}`}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  autonomy === "High"
                    ? "bg-[#fb923c]"
                    : autonomy === "Medium"
                      ? "bg-[#9B6AF1]"
                      : "bg-[#4ade80]",
                )}
              />
              <span className="text-[11px] text-[#71717A]">{autonomy}</span>
            </span>

            {/* Model pill */}
            <span
              className="ml-auto max-w-[140px] truncate rounded-md border border-[#1A1A1F] bg-[#0F0F14] px-2 py-0.5 font-mono text-[10px] text-[#52525B]"
              title={selectedModel.model}
            >
              {selectedModel.model.split("/").pop()}
            </span>
          </div>
        )}

        {!viewer.readOnly && contextStatus && (
          <ContextLimitDialog
            open={showContextLimit}
            onOpenChange={setShowContextLimit}
            contextStatus={contextStatus}
          />
        )}
        {!viewer.readOnly && activeTrackedRuns.length <= 1 && (
          <TokenBudgetMeter active={runActive} budget={runBudget} />
        )}
      </div>

      {/* ── Context bar ──────────────────────────────────────────────── */}
      <div className="row-start-2 min-w-0">
        {!viewer.readOnly && <ContextBar />}
      </div>

      {/* ── Run region ───────────────────────────────────────────────── */}
      <div className="row-start-3 min-h-0 min-w-0 overflow-hidden">
        <AgentPanelBoundary>
          <RunRegion />
        </AgentPanelBoundary>
      </div>

      {/* ── Composer ─────────────────────────────────────────────────── */}
      <div className="row-start-4">
        {viewer.readOnly ? (
          <div className="border-t border-[#1A1A1F] bg-[#0C0C10] px-3 py-2 text-center text-[11px] text-[#71717A]">
            Shared session controls are disabled (read-only).
          </div>
        ) : (
          <Composer />
        )}
      </div>
    </div>
  );
}

class AgentPanelBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Agent timeline render failed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="m-4 rounded-xl border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/8 p-4 text-[12px] text-[var(--zoc-error)]">
          <div className="font-semibold mb-1">Agent timeline render error</div>
          <div className="text-[var(--zoc-error)]/70 break-words">{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
