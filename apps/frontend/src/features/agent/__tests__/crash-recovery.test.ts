import { describe, expect, it } from "vitest";
import {
  crashBannerFor,
  crashSummary,
  formatCrashTime,
  formatReportForClipboard,
  NO_BANNER,
} from "../crash-recovery";
import type { CrashReport } from "@/lib/tauri-bridge";

const report = (over: Partial<CrashReport> = {}): CrashReport => ({
  timestamp: "2026-07-25T05:12:00Z",
  exit_code: 1,
  reason: "health unreachable",
  last_log_lines: ["starting", "ValueError: boom"],
  rust_version: "1.77.2",
  app_version: "0.0.2",
  os_info: "linux x86_64",
  ...over,
});

describe("crashBannerFor", () => {
  it("shows the restarting banner when the sidecar crashed", () => {
    const state = crashBannerFor(
      { running: false, last_error: "ValueError: boom", status: "crashed" },
      false,
    );
    expect(state.kind).toBe("crashed");
    expect(state.message).toBe("Agent crashed. Restarting…");
    expect(state.detail).toBe("ValueError: boom");
  });

  it("offers a retry only when a run was in flight", () => {
    const base = { running: false, last_error: null, status: "crashed" };
    expect(crashBannerFor(base, true).retryable).toBe(true);
    expect(crashBannerFor(base, false).retryable).toBe(false);
  });

  it("auto-dismisses once the agent reports running", () => {
    expect(crashBannerFor({ running: true, last_error: null, status: "running" }, true)).toEqual(
      NO_BANNER,
    );
    // `running: true` wins even if a stale phase says otherwise.
    expect(crashBannerFor({ running: true, last_error: "x", status: "crashed" }, true)).toEqual(
      NO_BANNER,
    );
  });

  it("shows nothing while merely starting or stopped", () => {
    expect(crashBannerFor({ running: false, last_error: null, status: "starting" }, true).kind).toBe(
      null,
    );
    expect(crashBannerFor({ running: false, last_error: null, status: "stopped" }, true).kind).toBe(
      null,
    );
  });

  it("tolerates a status payload from an older shell without a phase", () => {
    expect(crashBannerFor({ running: true, last_error: null }, false).kind).toBe(null);
    expect(crashBannerFor({ running: false, last_error: null }, false).kind).toBe(null);
  });
});

describe("crashSummary", () => {
  it("prefers the final log line", () => {
    expect(crashSummary(report())).toBe("ValueError: boom");
  });

  it("falls back to the reason, then the exit code", () => {
    expect(crashSummary(report({ last_log_lines: [] }))).toBe("health unreachable");
    expect(crashSummary(report({ last_log_lines: [], reason: "" }))).toBe(
      "Agent exited with code 1",
    );
    expect(
      crashSummary(report({ last_log_lines: [], reason: "", exit_code: null })),
    ).toBe("Agent exited unexpectedly");
  });
});

describe("formatCrashTime", () => {
  it("renders a parseable timestamp locally and passes junk through", () => {
    expect(formatCrashTime("2026-07-25T05:12:00Z")).not.toBe("2026-07-25T05:12:00Z");
    expect(formatCrashTime("not-a-date")).toBe("not-a-date");
  });
});

describe("formatReportForClipboard", () => {
  it("includes the metadata and the whole log tail", () => {
    const text = formatReportForClipboard(report());
    expect(text).toContain("Zoc AI crash report");
    expect(text).toContain("exit code:   1");
    expect(text).toContain("linux x86_64");
    expect(text).toContain("ValueError: boom");
  });

  it("renders a missing exit code as n/a", () => {
    expect(formatReportForClipboard(report({ exit_code: null }))).toContain("exit code:   n/a");
  });
});
