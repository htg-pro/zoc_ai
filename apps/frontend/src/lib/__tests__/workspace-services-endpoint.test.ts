/**
 * Workspace_Services endpoint resolver — zoc-agent-chat-rebuild task 3.3 (R3.3, R2.1).
 *
 * The half of the `agent-port.ts` split that carries no credential. The
 * no-header assertion below is deliberate: it is the one behavioural difference
 * from `runtime-endpoint.ts`, and an accidental credential here would be a
 * change to the trust boundary rather than a tightening of it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  agentPort: vi.fn(),
  agentStatus: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@/lib/tauri-bridge", () => bridge);

import {
  HEALTH_WAIT_MS,
  PORT_POLL_MS,
  PORT_WAIT_MS,
  WorkspaceServicesUnavailableError,
  resolveWorkspaceServicesEndpoint,
  waitForWorkspaceHealth,
} from "@/lib/workspace-services-endpoint";

const fetchMock = vi.fn();

beforeEach(() => {
  bridge.agentPort.mockReset();
  bridge.agentStatus.mockReset();
  bridge.isTauri.mockReturnValue(true);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("workspace services budget constants", () => {
  it("carries the agent-port budgets over unchanged (R3.3)", () => {
    expect(PORT_WAIT_MS).toBe(30_000);
    expect(HEALTH_WAIT_MS).toBe(30_000);
    expect(PORT_POLL_MS).toBe(250);
  });
});

describe("resolveWorkspaceServicesEndpoint", () => {
  it("resolves the running sidecar port with no credential on the probe", async () => {
    bridge.agentStatus.mockResolvedValue({
      port: 8712,
      running: true,
      restarts: 0,
      last_error: null,
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const services = await resolveWorkspaceServicesEndpoint();

    expect(services).toEqual({ port: 8712, baseUrl: "http://127.0.0.1:8712" });
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8712/health", {
      signal: undefined,
    });
  });

  it("throws WorkspaceServicesUnavailableError carrying the supervisor's last error", async () => {
    vi.useFakeTimers();
    bridge.agentStatus.mockResolvedValue({
      port: null,
      running: false,
      restarts: 2,
      last_error: "gateway exited during startup",
    });

    const settled = resolveWorkspaceServicesEndpoint().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS + PORT_POLL_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(WorkspaceServicesUnavailableError);
    expect((error as WorkspaceServicesUnavailableError).code).toBe("workspace_unavailable");
    expect((error as Error).message).toContain("gateway exited during startup");
  });

  it("throws when /health never answers within its budget", async () => {
    vi.useFakeTimers();
    bridge.agentStatus.mockResolvedValue({
      port: 8712,
      running: true,
      restarts: 0,
      last_error: null,
    });
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const settled = resolveWorkspaceServicesEndpoint().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HEALTH_WAIT_MS + PORT_POLL_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(WorkspaceServicesUnavailableError);
    expect((error as Error).message).toContain("http 503");
  });

  it("uses the dev port outside the desktop shell", async () => {
    bridge.isTauri.mockReturnValue(false);
    bridge.agentPort.mockResolvedValue(null);

    const services = await resolveWorkspaceServicesEndpoint();

    expect(services.port).toBe(3001);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("waitForWorkspaceHealth", () => {
  it("returns as soon as /health answers 200", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await expect(waitForWorkspaceHealth(8712)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops early when the caller aborts", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: false, status: 503 });
    const controller = new AbortController();

    const settled = waitForWorkspaceHealth(8712, controller.signal).catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(PORT_POLL_MS * 2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(PORT_POLL_MS * 2);

    const error = await settled;
    expect((error as Error).name).toBe("AbortError");
  });
});
