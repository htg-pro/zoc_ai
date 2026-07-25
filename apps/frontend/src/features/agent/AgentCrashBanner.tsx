import { useEffect, useRef, useState } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { useApp } from "@/lib/store";
import { agentRestart, onAgentStatus, type AgentStatus } from "@/lib/tauri-bridge";
import { trackEvent } from "@/lib/telemetry";
import { crashBannerFor, NO_BANNER, type CrashBannerState } from "./crash-recovery";

/**
 * Sidecar crash banner (§11.1).
 *
 * Subscribes to `agent://status` and renders a red bar while the agent is
 * crashed/restarting. When a run was in flight it also offers to re-fill the
 * composer with the interrupted prompt. The banner clears itself as soon as the
 * supervisor reports `running` again — no timers, purely status-driven.
 */
export function AgentCrashBanner() {
  const streaming = useApp((s) => s.streaming);
  const isRunning = useApp((s) => s.isRunning);
  const lastSentPrompt = useApp((s) => s.lastSentPrompt);
  const setInput = useApp((s) => s.setInput);

  const [banner, setBanner] = useState<CrashBannerState>(NO_BANNER);
  const [retrying, setRetrying] = useState(false);
  // Captured at crash time: by the time the user clicks, `streaming` is false.
  const hadActiveRun = useRef(false);

  useEffect(() => {
    if (streaming || isRunning) hadActiveRun.current = true;
  }, [streaming, isRunning]);

  useEffect(() => {
    let off: (() => void) | undefined;
    const onStatus = (status: AgentStatus) => {
      const next = crashBannerFor(status, hadActiveRun.current);
      setBanner(next);
      if (next.kind === "crashed") {
        // Anonymous counter only — no log content leaves the machine (§11.2).
        void trackEvent("crash", { exit_code: null });
      }
      if (next.kind === null) hadActiveRun.current = false;
    };
    void onAgentStatus(onStatus).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);

  if (banner.kind !== "crashed") return null;

  const retry = () => {
    setRetrying(true);
    if (lastSentPrompt) setInput(lastSentPrompt);
    void agentRestart().finally(() => setRetrying(false));
  };

  return (
    <div
      role="alert"
      data-testid="agent-crash-banner"
      className="flex flex-wrap items-center gap-2 border-b border-destructive/40 bg-destructive/12 px-3 py-1.5 text-[11px] text-destructive"
    >
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span className="font-medium">{banner.message}</span>
      {banner.detail && (
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] opacity-70">
          {banner.detail}
        </span>
      )}
      {banner.retryable && (
        <button
          type="button"
          onClick={retry}
          disabled={retrying}
          className="ml-auto inline-flex items-center gap-1 rounded border border-destructive/40 px-1.5 py-0.5 font-medium hover:bg-destructive/20 disabled:opacity-50"
        >
          <RotateCcw className="h-3 w-3" />
          Your run was interrupted. Click to retry.
        </button>
      )}
    </div>
  );
}
