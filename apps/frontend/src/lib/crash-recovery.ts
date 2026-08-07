/**
 * Sidecar crash recovery model (§11.1).
 *
 * The Rust supervisor pushes `agent://status` events; this module decides what
 * the user should see for a given status, and whether an interrupted run can be
 * retried. Keeping it pure means the state machine — including the "dismiss the
 * banner automatically once we're running again" rule — is testable without a
 * Tauri runtime.
 */
import type { AgentStatus, CrashReport } from "@/lib/tauri-bridge";

export type CrashBannerKind = "crashed" | "recovered" | null;

export interface CrashBannerState {
  kind: CrashBannerKind;
  message: string;
  /** The last error line from the sidecar log, when known. */
  detail: string | null;
  /** True when a run was in flight and can be re-sent. */
  retryable: boolean;
}

export const NO_BANNER: CrashBannerState = {
  kind: null,
  message: "",
  detail: null,
  retryable: false,
};

/**
 * Derive the banner from the current sidecar status.
 *
 * `hadActiveRun` is the caller's knowledge that a run was streaming when the
 * crash landed; only then is a retry offered, because re-sending a message the
 * user never sent would be worse than showing nothing.
 *
 * A `running` status always clears the banner — that is the auto-dismiss rule,
 * expressed as a function of state rather than a timer, so it cannot get stuck.
 */
export function crashBannerFor(
  status: Pick<AgentStatus, "running" | "last_error"> & {
    status?: string;
  },
  hadActiveRun: boolean,
): CrashBannerState {
  const phase = status.status ?? (status.running ? "running" : "starting");

  if (phase === "running" || status.running) return NO_BANNER;

  if (phase === "crashed") {
    return {
      kind: "crashed",
      message: "Agent crashed. Restarting…",
      detail: status.last_error ?? null,
      retryable: hadActiveRun,
    };
  }
  return NO_BANNER;
}

/** One-line summary for a crash report row in Diagnostics. */
export function crashSummary(report: CrashReport): string {
  const last = report.last_log_lines.at(-1)?.trim();
  if (last) return last;
  if (report.reason) return report.reason;
  return report.exit_code === null
    ? "Agent exited unexpectedly"
    : `Agent exited with code ${report.exit_code}`;
}

/** Local, human-readable timestamp for a crash report. */
export function formatCrashTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return timestamp;
  return new Date(parsed).toLocaleString();
}

/**
 * The clipboard payload for "Send report".
 *
 * Deliberately a local copy rather than an upload: the user reviews the log tail
 * before it leaves the machine (§11.1 "no network call — privacy first").
 */
export function formatReportForClipboard(report: CrashReport): string {
  return [
    "Zoc AI crash report",
    `time:        ${report.timestamp}`,
    `app:         ${report.app_version}`,
    `rust:        ${report.rust_version}`,
    `os:          ${report.os_info}`,
    `exit code:   ${report.exit_code ?? "n/a"}`,
    `reason:      ${report.reason}`,
    "",
    "--- last log lines ---",
    ...report.last_log_lines,
  ].join("\n");
}
