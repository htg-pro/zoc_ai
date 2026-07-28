import { Component, useState, useEffect, useMemo, type ErrorInfo, type ReactNode } from "react";
import { FilePenLine, FolderOpen, Pause, Play, Plug, RefreshCw, Square, Zap } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { ErrorCodes } from "@/lib/errors";
import { agentRestart, isTauri, pickDirectory } from "@/lib/tauri-bridge";
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
import { activeRuns } from "./agent-runs";
import { deriveRunPresence } from "./run-presence";
import { isReportedStage } from "./stage-report";
import { surfaceState } from "./surface-state";
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
  const chat             = useApp((s) => s.chat ?? []);
  const liveMode         = useApp((s) => s.liveMode ?? false);
  const agentSurfaceError = useApp((s) => s.agentSurfaceError ?? null);
  const setWorkspaceRoot = useApp((s) => s.setWorkspaceRoot);
  const setAgentSurfaceError = useApp((s) => s.setAgentSurfaceError);
  const refreshGit       = useApp((s) => s.refreshGit);
  const loadSessions     = useApp((s) => s.loadSessions);
  const sessionHistoryLoading = useApp((s) => s.sessionHistoryLoading ?? false);
  const requestComposerSubmit = useApp((s) => s.requestComposerSubmit);
  const lastSentPrompt   = useApp((s) => s.lastSentPrompt ?? "");
  const boundMessageId   = useApp((s) => s.boundMessageId ?? null);
  const openInstructions = useApp((s) => s.openProjectInstructions);
  const trackedRuns       = useApp((s) => s.trackedRuns ?? []);
  const focusedRunId      = useApp((s) => s.focusedRunId ?? null);
  const maxConcurrentRuns = useApp((s) => s.maxConcurrentRuns ?? 3);
  const focusRun          = useApp((s) => s.focusRun);
  const viewer             = useMemo(currentViewerContext, []);
  const runStartedAt       = useApp((s) => s.runStartedAt ?? null);
  // One derivation of "a run is happening", shared with the elapsed clock and
  // the run controls. See run-presence.ts for why this is not inline any more.
  const presence = deriveRunPresence({
    trackedRuns,
    focusedRunId,
    streaming,
    reviewRunning,
    testRunning,
    agentPaused,
    viewerReadOnly: viewer.readOnly,
    agentMode,
    activeRunMode,
    runStartedAt,
  });
  const activeTrackedRuns  = activeRuns(trackedRuns);
  const runActive          = presence.active;
  const stopRunId          = presence.stopRunId;
  const [showContextLimit, setShowContextLimit] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const phase    = presence.phase;
  const controls = controlAvailability(phase);

  // Elapsed is measured from the run's own start, not from when this effect
  // happened to run, so switching focus or remounting cannot reset a live run's
  // clock to 0:00.
  useEffect(() => {
    const startedAt = presence.startedAt;
    if (!runActive || startedAt === null) {
      setElapsedMs(0);
      return;
    }
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    const timer = setInterval(() => setElapsedMs(Math.max(0, Date.now() - startedAt)), 1000);
    return () => clearInterval(timer);
  }, [runActive, presence.startedAt]);

  const elapsedTime  = formatElapsed(elapsedMs);
  const displayMode  = presence.mode;
  const isAsk        = displayMode === "ask";
  const isPlan       = displayMode === "plan";
  const modeChrome = isAsk
    ? { label: "Ask", subtitle: "Read-only answers", accent: "text-[#60a5fa]" }
    : isPlan
      ? { label: "Plan", subtitle: "Review before edits", accent: "text-[#fbbf24]" }
      : { label: "Agent", subtitle: "Autonomous editing", accent: "text-[#9B6AF1]" };
  const statusText   = presence.statusText;

  // One aria-live region announces run phase/stage transitions — never per token
  // (R20.6). Its text changes only when the phase or a reported stage changes,
  // so a screen reader announces those and nothing else.
  const liveRegionText = useMemo(() => {
    const run =
      (focusedRunId ? trackedRuns.find((r) => r.runId === focusedRunId) : undefined) ??
      activeTrackedRuns[activeTrackedRuns.length - 1] ??
      trackedRuns[trackedRuns.length - 1];
    if (!run) return "";
    switch (run.phase) {
      case "initializing":
        return "Starting the run.";
      case "running":
        return run.stage && isReportedStage(run.stage)
          ? `Working: ${run.stage}.`
          : "Assistant is responding.";
      case "stopping":
        return "Stopping the run.";
      case "paused":
        return "Run paused.";
      case "done":
        return "Run finished.";
      case "failed":
        return "Run failed.";
      case "cancelled":
        return "Run stopped.";
      default:
        return "";
    }
  }, [focusedRunId, trackedRuns, activeTrackedRuns]);

  // A `git_not_a_repository` guard result is benign: version-control features
  // are unavailable but the chat still works, so it does NOT become a blocking
  // error surface — it shows a notice and hides git-dependent controls (R14.3).
  const notARepo = agentSurfaceError?.code === ErrorCodes.gitNotARepository;
  // The single precedence function for the panel's non-ideal states (R19). In
  // the browser preview there is no supervisor, so treat it as connected.
  const surface = surfaceState({
    connected: liveMode || !isTauri(),
    historyLoading: sessionHistoryLoading,
    workspaceRoot: workspaceRoot ?? null,
    rowCount: chat.length + trackedRuns.length,
    selectedModel: selectedModel.model || null,
    mode: displayMode === "plan" ? "plan" : displayMode === "agent" ? "agent" : "ask",
    lastError: notARepo ? null : agentSurfaceError,
  });

  const openWorkspaceFolder = () => {
    void (async () => {
      if (!isTauri()) return;
      const picked = await pickDirectory(workspaceRoot ?? null);
      if (picked) await setWorkspaceRoot(picked);
    })();
  };

  // R19.5 — reconnect to the Gateway explicitly: restart the sidecar, then
  // reload status by re-hydrating sessions (which sets liveMode on success).
  const [reconnecting, setReconnecting] = useState(false);
  const reconnectGateway = () => {
    void (async () => {
      setReconnecting(true);
      try {
        if (isTauri()) await agentRestart();
        await loadSessions();
      } finally {
        setReconnecting(false);
      }
    })();
  };

  return (
    <div
      className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-[#0C0C10]"
      data-testid="agent-panel"
    >
      {/* One polite live region for run phase/stage announcements (R20.6). It is
          `sr-only` (absolutely positioned), so it never consumes a grid row. */}
      <div aria-live="polite" role="status" className="sr-only" data-testid="agent-live-region">
        {liveRegionText}
      </div>
      {/* ── Header ───────────────────────────────────────────────────── */}
      <div className="row-start-1 shrink-0 border-b border-[#1A1A1F] bg-[#0C0C10]">
        <ViewerBanner />
        {!viewer.readOnly && <AgentCrashBanner />}
        <div className="agent-panel-header-row flex min-h-[48px] items-center gap-2 px-3.5 py-2">
          {/* Brand mark */}
          <div className="agent-panel-header-brand flex min-w-0 shrink-0 items-center gap-2.5">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#3B1F7C] to-[#1A0E3A] border border-[#7C3AED]/30 shadow-[0_0_12px_rgba(124,58,237,0.25)]">
              <Zap className="h-3.5 w-3.5 text-[#9B6AF1]" />
            </span>
            <div className="min-w-0">
              <div className="whitespace-nowrap text-[13px] font-semibold text-[#FAFAFA] leading-tight">
                Zoc
                <span className={cn("font-semibold", modeChrome.accent)}>
                  {` ${modeChrome.label}`}
                </span>
              </div>
              <div className="agent-panel-header-subtitle mt-0.5 max-w-[112px] truncate whitespace-nowrap text-[10px] leading-tight text-[#52525B]">
                {modeChrome.subtitle}
              </div>
            </div>
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-1.5">
            {!viewer.readOnly && <button
              type="button"
              onClick={() => void openInstructions()}
              disabled={!workspaceRoot}
              className="inline-flex h-6 items-center gap-1.5 rounded px-1.5 text-[10px] font-medium text-[#71717A] transition-colors hover:bg-[#17171C] hover:text-[#C8C8CE] disabled:cursor-not-allowed disabled:opacity-40"
              title={workspaceRoot ? "Open .zoc/instructions.md" : "Open a workspace first"}
            >
              <FilePenLine className="h-3 w-3 shrink-0" />
              <span className="agent-panel-instructions-label">Edit instructions</span>
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
                <span className="agent-panel-idle inline-flex h-5 items-center rounded-full border border-[#1E1E23] bg-[#141419] px-2 font-mono text-[10px] text-[#52525B]">
                  idle
                </span>
                {!viewer.readOnly && <div className="agent-panel-model-picker min-w-0"><ModelPicker /></div>}
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
          {viewer.readOnly ? (
            // A shared-session viewer only mirrors the host's run — local
            // workspace/connection surface states do not apply.
            <RunRegion />
          ) : surface.kind === "loading" ? (
            <HistoryLoadingSurface />
          ) : surface.kind === "workspace-required" ? (
            <WorkspaceRequiredSurface onOpenFolder={openWorkspaceFolder} canPick={isTauri()} />
          ) : surface.kind === "disconnected" ? (
            <DisconnectedSurface onReconnect={reconnectGateway} reconnecting={reconnecting} />
          ) : surface.kind === "error" ? (
            <SurfaceErrorState
              operation={surface.operation}
              code={surface.code}
              message={surface.message}
              retryable={surface.retryable}
              onRetry={() => {
                const err = agentSurfaceError;
                setAgentSurfaceError(null);
                // A run/model/credential failure retries by re-running the last
                // prompt through the Composer's current-mode path (R19.6); a
                // git/workspace error just re-probes git.
                if (
                  err &&
                  (err.operation === "run" || err.operation === "sendUserMessage") &&
                  lastSentPrompt
                ) {
                  requestComposerSubmit(lastSentPrompt, {
                    reuseMessageId: boundMessageId,
                  });
                } else {
                  void refreshGit();
                }
              }}
            />
          ) : notARepo ? (
            <div className="flex h-full min-h-0 flex-col">
              <NonRepoNotice message={agentSurfaceError?.message ?? ""} />
              <div className="min-h-0 flex-1">
                <RunRegion />
              </div>
            </div>
          ) : surface.kind === "empty" ? (
            <RichEmptySurface
              model={surface.model}
              mode={surface.mode}
              examples={surface.examples}
              onPick={(prompt) => requestComposerSubmit(prompt)}
            />
          ) : (
            <RunRegion />
          )}
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


/** R19.3 — no workspace resolved: name the cause and offer a folder picker. */
function WorkspaceRequiredSurface({
  onOpenFolder,
  canPick,
}: {
  onOpenFolder: () => void;
  canPick: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <FolderOpen className="h-8 w-8 text-[#71717A]" />
      <div className="text-[13px] font-medium text-[#C8C8CE]">No workspace open</div>
      <p className="max-w-sm text-[12px] text-[#71717A]">
        Open a project folder before using Plan or Agent mode. Ask mode works
        without one.
      </p>
      <button
        type="button"
        onClick={onOpenFolder}
        disabled={!canPick}
        className="zoc-focus-ring inline-flex items-center gap-1.5 rounded-md border border-[#26262B] bg-[#15151A] px-3 py-1.5 text-[12px] text-[#D4D4D8] transition-colors hover:bg-[#1E1E23] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <FolderOpen className="h-3.5 w-3.5" />
        Open folder…
      </button>
    </div>
  );
}

/** R19.5 — the Gateway is unreachable; offer an explicit Reconnect. */
function DisconnectedSurface({
  onReconnect,
  reconnecting,
}: {
  onReconnect: () => void;
  reconnecting: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <Plug className="h-8 w-8 text-[#71717A]" />
      <div className="text-[13px] font-medium text-[#C8C8CE]">Gateway disconnected</div>
      <p className="max-w-sm text-[12px] text-[#71717A]">
        Can&apos;t reach the Zoc Gateway. Reconnect to restart the agent service
        and reload its status.
      </p>
      <button
        type="button"
        onClick={onReconnect}
        disabled={reconnecting}
        data-testid="gateway-reconnect"
        className="zoc-focus-ring inline-flex items-center gap-1.5 rounded-md border border-[#26262B] bg-[#15151A] px-3 py-1.5 text-[12px] text-[#D4D4D8] transition-colors hover:bg-[#1E1E23] disabled:cursor-not-allowed disabled:opacity-40"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", reconnecting && "animate-spin")} />
        {reconnecting ? "Reconnecting…" : "Reconnect to Gateway"}
      </button>
    </div>
  );
}

/** R19.2 — session history is loading; show a placeholder, never an empty state. */
function HistoryLoadingSurface() {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="history-loading"
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="h-6 w-6 animate-spin text-[#71717A]" />
      <div className="text-[12px] text-[#71717A]">Loading conversation history…</div>
    </div>
  );
}

/** R19.1 — the rich empty state: names the model + mode and offers examples. */
function RichEmptySurface({
  model,
  mode,
  examples,
  onPick,
}: {
  model: string;
  mode: string;
  examples: readonly string[];
  onPick: (prompt: string) => void;
}) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center"
      data-testid="agent-empty-state"
    >
      <Zap className="h-8 w-8 text-[#9B6AF1]" />
      <div className="text-[13px] font-medium text-[#C8C8CE]">
        {mode === "ask" ? "Ask about your code" : "Start a task"}
      </div>
      <p className="max-w-sm text-[12px] text-[#71717A]">
        <span className="font-mono text-[#A1A1AA]">{model}</span>
        {" · "}
        <span className="capitalize">{mode}</span> mode
      </p>
      <div className="flex max-w-sm flex-wrap justify-center gap-1.5">
        {examples.map((example) => (
          <button
            key={example}
            type="button"
            onClick={() => onPick(example)}
            className="zoc-focus-ring rounded-full border border-[#26262B] bg-[#141419] px-3 py-1 text-[11.5px] text-[#D4D4D8] transition-colors hover:border-[var(--zoc-accent,#a78bfa)]/40"
          >
            {example}
          </button>
        ))}
      </div>
    </div>
  );
}

/** R19.4/R19.6 — a typed operation error, with retry when the code allows it. */
function SurfaceErrorState({
  operation,
  code,
  message,
  retryable,
  onRetry,
}: {
  operation: string;
  code: string;
  message: string;
  retryable: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[13px] font-medium text-[var(--zoc-error)]">Something went wrong</div>
      <p className="max-w-sm text-[12px] text-[#A1A1AA]" role="alert">
        {message}
      </p>
      {/* Operation + code stay visible for support, never just the prose (R19.6). */}
      <span className="font-mono text-[10.5px] text-[#52525B]" data-testid="surface-error-meta">
        {operation} · {code}
      </span>
      {retryable && (
        <button
          type="button"
          onClick={onRetry}
          className="zoc-focus-ring inline-flex items-center gap-1.5 rounded-md border border-[#26262B] bg-[#15151A] px-3 py-1.5 text-[12px] text-[#D4D4D8] transition-colors hover:bg-[#1E1E23]"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      )}
    </div>
  );
}

/** R14.3 — a benign "this folder isn't a Git repository" notice above the feed. */
function NonRepoNotice({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="shrink-0 border-b border-[#1A1A1F] bg-[#15151A] px-3.5 py-1.5 text-[11px] text-[#71717A]"
    >
      {message}
    </div>
  );
}
