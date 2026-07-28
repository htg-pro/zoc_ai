/**
 * Agent_Runtime endpoint resolver — zoc-agent-chat-rebuild task 3.3 (R3.3, R3.4, R2.1).
 *
 * The readiness budget is 30 s of wall clock, so every exhaustion test drives
 * fake timers rather than waiting. `advanceTimersByTimeAsync` is the one that
 * flushes the microtasks between poll intervals; the synchronous variant leaves
 * the loop parked on its first `await`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  agentRuntimeEndpoint: vi.fn(),
  agentRuntimeStatus: vi.fn(),
  isTauri: vi.fn(() => true),
}));

vi.mock("@/lib/tauri-bridge", () => bridge);

import {
  HEALTH_WAIT_MS,
  PORT_POLL_MS,
  PORT_WAIT_MS,
  RuntimeUnavailableError,
  resolveRuntimeEndpoint,
  runtimeAuthHeaders,
  waitForRuntimeHealth,
} from "@/lib/runtime-endpoint";

const fetchMock = vi.fn();

beforeEach(() => {
  bridge.agentRuntimeEndpoint.mockReset();
  bridge.agentRuntimeStatus.mockReset();
  bridge.agentRuntimeStatus.mockResolvedValue(null);
  bridge.isTauri.mockReturnValue(true);
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("runtime endpoint budget constants", () => {
  it("carries the agent-port budgets over unchanged (R3.3)", () => {
    expect(PORT_WAIT_MS).toBe(30_000);
    expect(HEALTH_WAIT_MS).toBe(30_000);
    expect(PORT_POLL_MS).toBe(250);
  });
});

describe("resolveRuntimeEndpoint", () => {
  it("returns the port, token, and base URL once /health answers 200 with the token", async () => {
    bridge.agentRuntimeEndpoint.mockResolvedValue({
      port: 45231,
      token: "launch-token",
      status: "running",
    });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const runtime = await resolveRuntimeEndpoint();

    expect(runtime).toEqual({
      port: 45231,
      token: "launch-token",
      baseUrl: "http://127.0.0.1:45231",
    });
    // Readiness is a 200 from /health *presented with the token* (R3.4).
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:45231/health", {
      headers: { authorization: "Bearer launch-token" },
      signal: undefined,
    });
  });

  it("keeps polling while the supervisor withholds the token, then resolves", async () => {
    vi.useFakeTimers();
    bridge.agentRuntimeEndpoint
      .mockResolvedValueOnce({ port: null, token: null, status: "starting" })
      .mockResolvedValueOnce({ port: 45231, token: null, status: "starting" })
      .mockResolvedValue({ port: 45231, token: "launch-token", status: "running" });
    fetchMock.mockResolvedValue({ ok: true, status: 200 });

    const pending = resolveRuntimeEndpoint();
    await vi.advanceTimersByTimeAsync(PORT_POLL_MS * 3);

    await expect(pending).resolves.toMatchObject({ port: 45231, token: "launch-token" });
    expect(bridge.agentRuntimeEndpoint.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("throws RuntimeUnavailableError when the port budget is exhausted", async () => {
    vi.useFakeTimers();
    bridge.agentRuntimeEndpoint.mockResolvedValue({
      port: null,
      token: null,
      status: "starting",
    });

    const pending = resolveRuntimeEndpoint();
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS + PORT_POLL_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(RuntimeUnavailableError);
    expect((error as RuntimeUnavailableError).code).toBe("runtime_unavailable");
    expect((error as Error).message).toContain("the supervisor reported no endpoint");
    // Nothing was ever probed, because no endpoint was ever offered.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports the supervisor's own failure reason when the budget elapses", async () => {
    vi.useFakeTimers();
    bridge.agentRuntimeEndpoint.mockResolvedValue({
      port: null,
      token: null,
      status: "crashed",
    });
    bridge.agentRuntimeStatus.mockResolvedValue({
      port: null,
      running: false,
      restarts: 3,
      last_error: "runtime exited with code 1",
      status: "crashed",
    });

    const pending = resolveRuntimeEndpoint();
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS + PORT_POLL_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(RuntimeUnavailableError);
    expect((error as Error).message).toContain("runtime exited with code 1");
  });

  it("throws RuntimeUnavailableError when /health never answers 200 within its budget", async () => {
    vi.useFakeTimers();
    bridge.agentRuntimeEndpoint.mockResolvedValue({
      port: 45231,
      token: "launch-token",
      status: "running",
    });
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    const pending = resolveRuntimeEndpoint();
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HEALTH_WAIT_MS + PORT_POLL_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(RuntimeUnavailableError);
    // A 401 is the interesting case: the listener is up and the token is wrong,
    // which is exactly what a port-only readiness check would have missed.
    expect((error as Error).message).toContain("did not pass /health");
    expect((error as Error).message).toContain("http 401");
  });

  it("stops early when the caller aborts", async () => {
    vi.useFakeTimers();
    bridge.agentRuntimeEndpoint.mockResolvedValue({
      port: null,
      token: null,
      status: "starting",
    });
    const controller = new AbortController();

    const pending = resolveRuntimeEndpoint(controller.signal);
    const settled = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(PORT_POLL_MS * 2);
    controller.abort();
    await vi.advanceTimersByTimeAsync(PORT_POLL_MS * 2);

    const error = await settled;
    // The abort reason propagates as-is (a DOMException), deliberately: a
    // cancelled wait is not an unavailable runtime, so it must not arrive at the
    // crash banner wearing RuntimeUnavailableError's clothes.
    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(RuntimeUnavailableError);
    const callsAtAbort = bridge.agentRuntimeEndpoint.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PORT_WAIT_MS);
    expect(bridge.agentRuntimeEndpoint.mock.calls.length).toBe(callsAtAbort);
  });

  it("falls back to the dev port outside the desktop shell without probing health", async () => {
    bridge.isTauri.mockReturnValue(false);

    const runtime = await resolveRuntimeEndpoint();

    expect(runtime.port).toBeGreaterThan(0);
    expect(runtime.baseUrl).toBe(`http://127.0.0.1:${runtime.port}`);
    expect(bridge.agentRuntimeEndpoint).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("waitForRuntimeHealth", () => {
  it("returns as soon as /health answers 200", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await expect(waitForRuntimeHealth(45231, "launch-token")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("carries the transport error text into the thrown reason", async () => {
    vi.useFakeTimers();
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    const settled = waitForRuntimeHealth(45231, "launch-token").catch(
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(HEALTH_WAIT_MS + PORT_POLL_MS);

    const error = await settled;
    expect(error).toBeInstanceOf(RuntimeUnavailableError);
    expect((error as Error).message).toContain("ECONNREFUSED");
  });

  it("sends no Authorization header in a token-less browser preview", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await waitForRuntimeHealth(3011, "");
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3011/health", {
      headers: {},
      signal: undefined,
    });
  });
});

describe("runtimeAuthHeaders", () => {
  it("presents the bearer for a resolved runtime and nothing for a preview", () => {
    expect(
      runtimeAuthHeaders({ port: 1, token: "t", baseUrl: "http://127.0.0.1:1" }),
    ).toEqual({ authorization: "Bearer t" });
    expect(
      runtimeAuthHeaders({ port: 1, token: "", baseUrl: "http://127.0.0.1:1" }),
    ).toEqual({});
  });
});
