import { Component, useState, useEffect, type ErrorInfo, type ReactNode } from "react";
import { Zap, Pause, Play, Square } from "lucide-react";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { formatElapsed } from "@/lib/format-elapsed";
import { controlAvailability } from "@/lib/run-machine";
import { AgentMenu } from "./AgentMenu";
import { RunRegion } from "./RunRegion";
import { Composer } from "./Composer";
import { ContextBar } from "./ContextBar";
import { ContextLimitDialog } from "./ContextLimitDialog";
import { ModelPicker } from "./ModelPicker";

export function AgentPanel() {
  const contextStatus = useApp((s) => s.contextStatus);
  const streaming = useApp((s) => s.streaming);
  const agentMode = useApp((s) => s.agentMode);
  const activeRunMode = useApp((s) => s.activeRunMode);
  const reviewRunning = useApp((s) => s.reviewRunning);
  const testRunning = useApp((s) => s.testGenRunning || s.testRunRunning);
  const runActive = streaming || reviewRunning || testRunning;
  const cancelStream = useApp((s) => s.cancelStream);
  const selectedModel = useApp((s) => s.selectedModel);
  const autonomy = useApp((s) => s.autonomy);
  const agentPaused = useApp((s) => s.agentPaused);
  const pauseAgent = useApp((s) => s.pauseAgent);
  const resumeAgent = useApp((s) => s.resumeAgent);
  const [showContextLimit, setShowContextLimit] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  // R7.8: control availability is a pure function of the lifecycle phase.
  const phase = runActive ? (agentPaused ? "paused" : "running") : "idle";
  const controls = controlAvailability(phase);

  useEffect(() => {
    if (!runActive) {
      setElapsedMs(0);
      return;
    }
    const start = Date.now();
    setElapsedMs(0);
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 1000);
    return () => clearInterval(timer);
  }, [runActive]);

  const elapsedTime = formatElapsed(elapsedMs);

  const displayMode = runActive ? activeRunMode ?? agentMode : agentMode;
  const isAsk = displayMode === "ask";
  const headerWord = isAsk ? "Ask" : "Agent";
  const subtitle = isAsk
    ? runActive
      ? "Answering…"
      : "Read-only answers"
    : runActive
      ? "Auto run · isolated changes"
      : "Auto run";

  return (
    <div
      className="grid h-full min-h-0 min-w-0 grid-cols-1 grid-rows-[auto_auto_minmax(0,1fr)_auto] bg-background"
      data-testid="agent-panel"
    >
      <div className="shrink-0 flex min-w-0 flex-col border-b border-[#1E1E23] bg-[#101014] row-start-1">
        {/* Top bar info */}
        <div className="flex min-h-[44px] items-center gap-2.5 px-3 py-1.5">
          <span className="w-7 h-7 rounded-lg bg-[rgba(251,146,60,0.12)] border border-[rgba(251,146,60,0.28)] flex items-center justify-center text-[var(--zoc-ember)] shrink-0">
            <Zap className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold leading-tight">
              <span className="text-[#FAFAFA]">Zoc</span>{" "}
              <span className="text-[var(--zoc-ember)]">{headerWord}</span>
            </div>
            <div className="text-[11px] text-[#71717A] leading-tight mt-0.5">
              {subtitle}
            </div>
          </div>

          {runActive ? (
            <span className="ml-auto flex items-center gap-1.5 h-[22px] px-2 rounded-full bg-[hsl(var(--primary)/0.12)] border border-[hsl(var(--primary)/0.3)] shrink-0">
              <span className={cn("w-1.5 h-1.5 rounded-full bg-primary", !agentPaused && "animate-pulse-dot")}></span>
              <span className="text-[11px] font-medium text-primary/85">
                {agentPaused ? "Paused" : isAsk ? "Answering…" : "Building…"}
              </span>
            </span>
          ) : (
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <span className="flex items-center h-[20px] px-2 rounded-full bg-[#1B1B21] border border-[#26262B] text-[10px] font-mono text-muted-foreground shrink-0">
                idle
              </span>
              <ModelPicker />
            </div>
          )}
          
          <AgentMenu />
        </div>

        {/* Active execution control bar */}
        {runActive && (
          <div className="flex items-center gap-2 px-3 pb-2.5 border-t border-[#1E1E23]/60 pt-2 shrink-0">
            <button
              type="button"
              onClick={() => (agentPaused ? resumeAgent() : pauseAgent())}
              disabled={agentPaused ? !controls.resume : !controls.pause}
              className="w-7 h-7 rounded-md border border-[#26262B] bg-background/40 hover:bg-[#1B1B21] flex items-center justify-center text-[#A1A1AA] transition-colors shrink-0 disabled:opacity-40 disabled:pointer-events-none"
              title={agentPaused ? "Resume run" : "Pause run"}
            >
              {agentPaused ? <Play className="w-3 h-3 fill-current text-primary" /> : <Pause className="w-3 h-3 fill-current text-[#A1A1AA]" />}
            </button>
            <button
              type="button"
              onClick={() => cancelStream()}
              disabled={!controls.stop}
              className="w-7 h-7 rounded-md bg-[rgba(248,113,113,0.12)] border border-[rgba(248,113,113,0.3)] hover:bg-[rgba(248,113,113,0.2)] flex items-center justify-center text-[#F87171] transition-colors shrink-0 disabled:opacity-40 disabled:pointer-events-none"
              title="Stop run"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
            </button>
            <span className="font-mono text-[11.5px] text-[#A1A1AA] shrink-0">
              {elapsedTime}
            </span>
            <span className="flex items-center gap-1.5 h-6 px-2 rounded-md border border-[#26262B] bg-background/30 shrink-0" title={`Autonomy level: ${autonomy}`}>
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  autonomy === "High"
                    ? "bg-warning"
                    : autonomy === "Medium"
                      ? "bg-primary"
                      : "bg-success",
                )}
              ></span>
              <span className="text-[11px] text-[#A1A1AA]">{autonomy}</span>
            </span>
            <span className="ml-auto font-mono h-6 max-w-[150px] flex items-center px-2 rounded-md bg-[#15151A] border border-[#1E1E23] text-[10px] text-[#71717A] shrink-0" title={selectedModel.model}>
              <span className="truncate">{selectedModel.model.split("/").pop()}</span>
            </span>
          </div>
        )}

        {contextStatus && (
          <ContextLimitDialog
            open={showContextLimit}
            onOpenChange={setShowContextLimit}
            contextStatus={contextStatus}
          />
        )}
      </div>
      <div className="row-start-2 min-w-0">
        <ContextBar />
      </div>
      <div className="row-start-3 min-h-0 min-w-0 overflow-hidden">
        <AgentPanelBoundary>
          <RunRegion />
        </AgentPanelBoundary>
      </div>
      <div className="row-start-4">
        <Composer />
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
        <div className="m-3 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <div className="font-medium">The agent timeline hit a render error.</div>
          <div className="mt-1 break-words text-destructive/80">{this.state.error.message}</div>
        </div>
      );
    }
    return this.props.children;
  }
}
