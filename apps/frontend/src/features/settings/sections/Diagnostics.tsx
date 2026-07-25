import { useCallback, useEffect, useState } from "react";
import { ChevronRight, ClipboardCopy, HeartPulse, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  agentCrashReports,
  agentCrashReportsClear,
  agentStatus,
  isTauri,
  type AgentStatus,
  type CrashReport,
} from "@/lib/tauri-bridge";
import {
  crashSummary,
  formatCrashTime,
  formatReportForClipboard,
} from "@/features/agent/crash-recovery";
import { cn } from "@/lib/utils";

/**
 * Settings → Diagnostics (§11.1).
 *
 * Lists the crash reports the Rust supervisor wrote to
 * `~/.zoc-studio/crashes/`. "Send report" copies the report to the clipboard
 * rather than uploading it — nothing here makes a network call, so the user
 * chooses what leaves the machine.
 */
export function DiagnosticsSection() {
  const [reports, setReports] = useState<CrashReport[]>([]);
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const desktop = isTauri();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [list, current] = await Promise.all([agentCrashReports(), agentStatus()]);
      setReports(list);
      setStatus(current);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const copy = async (report: CrashReport) => {
    try {
      await navigator.clipboard.writeText(formatReportForClipboard(report));
      toast.success("Crash report copied", {
        description: "Paste it into an issue — nothing was uploaded.",
      });
    } catch {
      toast.error("Couldn't copy the report");
    }
  };

  const clearAll = async () => {
    const removed = await agentCrashReportsClear();
    await refresh();
    toast.message(removed ? `Removed ${removed} report(s)` : "No reports to remove");
  };

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <HeartPulse className="h-4 w-4" /> Diagnostics
        </h2>
        <p className="text-xs text-muted-foreground">
          Crash reports are stored locally in <code>~/.zoc-studio/crashes/</code>{" "}
          and are never sent anywhere automatically.
        </p>
      </header>

      <div className="rounded-lg border border-border p-3 text-xs">
        <div className="mb-2 font-medium">Agent sidecar</div>
        {status ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
            <dt>Phase</dt>
            <dd
              className={cn(
                "font-mono",
                status.status === "crashed" && "text-destructive",
                status.status === "running" && "text-success",
              )}
            >
              {status.status ?? (status.running ? "running" : "stopped")}
            </dd>
            <dt>Port</dt>
            <dd className="font-mono">{status.port ?? "—"}</dd>
            <dt>Restarts</dt>
            <dd className="font-mono">{status.restarts}</dd>
            <dt>Last error</dt>
            <dd className="truncate font-mono" title={status.last_error ?? ""}>
              {status.last_error ?? "—"}
            </dd>
          </dl>
        ) : (
          <p className="text-muted-foreground">
            {desktop ? "Status unavailable." : "Desktop app only."}
          </p>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" disabled={loading} onClick={() => void refresh()}>
          <RefreshCw className={cn("mr-1 h-3.5 w-3.5", loading && "animate-spin")} />
          Refresh
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive"
          disabled={reports.length === 0}
          onClick={() => void clearAll()}
        >
          <Trash2 className="mr-1 h-3.5 w-3.5" />
          Clear all
        </Button>
      </div>

      {reports.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
          No crashes recorded. 🎉
        </p>
      ) : (
        <ul className="space-y-2">
          {reports.map((report) => {
            const key = report.file ?? report.timestamp;
            const open = expanded === key;
            return (
              <li key={key} className="rounded-lg border border-border">
                <div className="flex items-start gap-2 p-3">
                  <button
                    type="button"
                    onClick={() => setExpanded(open ? null : key)}
                    aria-expanded={open}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                    title={open ? "Collapse" : "Expand log tail"}
                  >
                    <ChevronRight
                      className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">{formatCrashTime(report.timestamp)}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {crashSummary(report)}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                      <span>exit {report.exit_code ?? "n/a"}</span>
                      <span>v{report.app_version}</span>
                      <span>{report.os_info}</span>
                    </div>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void copy(report)}>
                    <ClipboardCopy className="mr-1 h-3.5 w-3.5" />
                    Send report
                  </Button>
                </div>
                {open && (
                  <pre className="max-h-64 overflow-auto border-t border-border bg-muted/40 p-3 font-mono text-[10.5px] leading-relaxed">
                    {report.last_log_lines.join("\n") || "(no log lines captured)"}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
