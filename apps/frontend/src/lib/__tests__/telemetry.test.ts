import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  desktopConfigGet: vi.fn(),
  telemetryLog: vi.fn(),
  telemetryEvent: vi.fn(),
  telemetryStats: vi.fn(),
  telemetryDrain: vi.fn(),
}));

vi.mock("../tauri-bridge", () => bridge);

import {
  TELEMETRY_ENDPOINT,
  UPLOAD_THRESHOLD,
  __setConsentForTests,
  flushTelemetry,
  invalidateConsent,
  platformLabels,
  shouldUpload,
  track,
  trackEvent,
} from "../telemetry";

const optedIn = { telemetry_opt_in: true };
const optedOut = { telemetry_opt_in: false };

beforeEach(() => {
  vi.clearAllMocks();
  __setConsentForTests(null);
  bridge.telemetryStats.mockResolvedValue({
    opted_in: false,
    events: 0,
    bytes: 0,
    path: "",
  });
  bridge.telemetryDrain.mockResolvedValue([]);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("consent gating", () => {
  it("records nothing when the user has not opted in", async () => {
    bridge.desktopConfigGet.mockResolvedValue(optedOut);

    await trackEvent("plugin_installed", {});
    await track("app.boot", { tauri: true });

    expect(bridge.telemetryEvent).not.toHaveBeenCalled();
    expect(bridge.telemetryLog).not.toHaveBeenCalled();
  });

  it("records once the user opts in", async () => {
    bridge.desktopConfigGet.mockResolvedValue(optedIn);

    await trackEvent("lsp_connected", { language: "python" });

    expect(bridge.telemetryEvent).toHaveBeenCalledWith("lsp_connected", {
      language: "python",
    });
  });

  it("caches consent and re-reads it after invalidation", async () => {
    bridge.desktopConfigGet.mockResolvedValue(optedIn);
    await trackEvent("plugin_installed", {});
    await trackEvent("plugin_installed", {});
    expect(bridge.desktopConfigGet).toHaveBeenCalledTimes(1);

    invalidateConsent();
    await trackEvent("plugin_installed", {});
    expect(bridge.desktopConfigGet).toHaveBeenCalledTimes(2);
  });

  it("never throws when the shell rejects", async () => {
    bridge.desktopConfigGet.mockResolvedValue(optedIn);
    bridge.telemetryEvent.mockRejectedValue(new Error("no shell"));
    await expect(trackEvent("crash", { exit_code: 1 })).resolves.toBeUndefined();
  });

  it("routes local diagnostics to the never-uploaded channel", async () => {
    bridge.desktopConfigGet.mockResolvedValue(optedIn);
    await track("indexer.rebuilt", { root: "/home/me/project" });
    // Workspace detail goes to telemetry_log, never telemetry_event.
    expect(bridge.telemetryLog).toHaveBeenCalled();
    expect(bridge.telemetryEvent).not.toHaveBeenCalled();
  });
});

describe("shouldUpload", () => {
  it("requires both opt-in and more than the threshold", () => {
    expect(shouldUpload({ opted_in: true, events: UPLOAD_THRESHOLD + 1 })).toBe(true);
    expect(shouldUpload({ opted_in: true, events: UPLOAD_THRESHOLD })).toBe(false);
    expect(shouldUpload({ opted_in: false, events: 100_000 })).toBe(false);
  });
});

describe("flushTelemetry", () => {
  it("makes no request when the user has not opted in", async () => {
    bridge.telemetryStats.mockResolvedValue({
      opted_in: false,
      events: 5000,
      bytes: 1,
      path: "p",
    });

    expect(await flushTelemetry()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
    expect(bridge.telemetryDrain).not.toHaveBeenCalled();
  });

  it("makes no request below the threshold", async () => {
    bridge.telemetryStats.mockResolvedValue({
      opted_in: true,
      events: 10,
      bytes: 1,
      path: "p",
    });

    expect(await flushTelemetry()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("posts the drained batch when a flush is due", async () => {
    bridge.telemetryStats.mockResolvedValue({
      opted_in: true,
      events: UPLOAD_THRESHOLD + 1,
      bytes: 1,
      path: "p",
    });
    bridge.telemetryDrain.mockResolvedValue([{ kind: "app_start" }, { kind: "crash" }]);

    expect(await flushTelemetry()).toBe(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(TELEMETRY_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({
      events: [{ kind: "app_start" }, { kind: "crash" }],
    });
  });

  it("fails silently when the collector is unreachable", async () => {
    bridge.telemetryStats.mockResolvedValue({
      opted_in: true,
      events: UPLOAD_THRESHOLD + 1,
      bytes: 1,
      path: "p",
    });
    bridge.telemetryDrain.mockResolvedValue([{ kind: "app_start" }]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(flushTelemetry()).resolves.toBe(0);
  });
});

describe("platformLabels", () => {
  it("maps common user agents to coarse os/arch", () => {
    expect(platformLabels("Mozilla/5.0 (X11; Linux x86_64)")).toEqual({
      os: "linux",
      arch: "x86_64",
    });
    expect(platformLabels("Mozilla/5.0 (Macintosh; ARM64 Mac OS X)")).toEqual({
      os: "macos",
      arch: "arm64",
    });
    expect(platformLabels("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toEqual({
      os: "windows",
      arch: "x86_64",
    });
    expect(platformLabels("")).toEqual({ os: "unknown", arch: "unknown" });
  });
});
