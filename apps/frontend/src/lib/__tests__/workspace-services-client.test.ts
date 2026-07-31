/**
 * Workspace_Services client — zoc-agent-chat-rebuild task 22.1 (R6.3, R6.5).
 *
 * What this file is actually guarding is the *shape of the surface*, not the
 * plumbing: the client's value is that it is the short list of calls the renderer
 * still makes to the Python process outside a Run, and the way that list stops
 * growing back is a test that fails when a retired capability reappears. Hence
 * the structural test at the bottom, which asserts absence rather than presence.
 *
 * The per-call assertions exist for one reason each: a wrong verb or a wrong path
 * on any of these is a silent 404 or, worse for `PATCH` vs `PUT`, a 405 that a
 * caller reports to the user as "settings could not be saved".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const endpoint = vi.hoisted(() => ({
  resolveWorkspaceServicesEndpoint: vi.fn(),
}));

vi.mock("@/lib/workspace-services-endpoint", () => endpoint);

import { normalizeError } from "@/lib/errors";
import {
  WorkspaceServicesRequestError,
  getWorkspaceServicesClient,
  makeWorkspaceServicesClient,
  resetWorkspaceServicesClient,
  workspaceServicesEndpoint,
} from "@/lib/workspace-services-client";

const fetchMock = vi.fn();

/** A 200 carrying JSON, which is what almost every route here answers with. */
function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function failure(status: number, body: unknown): Response {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok: false,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

/** The `(url, init)` pair of the single call made. */
function callArgs(index = 0): [string, RequestInit] {
  const call = fetchMock.mock.calls[index] as [string, RequestInit] | undefined;
  if (call === undefined) throw new Error(`no fetch call at index ${String(index)}`);
  return call;
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(jsonOk({}));
  vi.stubGlobal("fetch", fetchMock);
  endpoint.resolveWorkspaceServicesEndpoint.mockReset();
  endpoint.resolveWorkspaceServicesEndpoint.mockResolvedValue({
    port: 8712,
    baseUrl: "http://127.0.0.1:8712",
  });
  resetWorkspaceServicesClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetWorkspaceServicesClient();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: the Workspace_Services client", () => {
  const client = () => makeWorkspaceServicesClient(8712);

  it("reads and writes a Session on the routes the gateway serves (R15.1–R15.4)", async () => {
    await client().listSessions();
    expect(callArgs()[0]).toBe("http://127.0.0.1:8712/v1/sessions");

    fetchMock.mockClear();
    await client().createSession({ title: "New session" } as never);
    const [createUrl, createInit] = callArgs();
    expect(createUrl).toBe("http://127.0.0.1:8712/v1/sessions");
    expect(createInit.method).toBe("POST");
    expect(createInit.body).toBe(JSON.stringify({ title: "New session" }));

    fetchMock.mockClear();
    await client().updateSession("s1", { title: "Renamed" });
    const [patchUrl, patchInit] = callArgs();
    expect(patchUrl).toBe("http://127.0.0.1:8712/v1/sessions/s1");
    // PATCH, not PUT: the gateway routes them separately, and a PUT here is a 405
    // the surface reports as "the rename did not save".
    expect(patchInit.method).toBe("PATCH");
  });

  it("archives through the status field rather than a second route (R15.11)", async () => {
    await client().updateSession("s1", { status: "closed" });
    const [url, init] = callArgs();
    expect(url).toBe("http://127.0.0.1:8712/v1/sessions/s1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ status: "closed" }));
  });

  it("restores a transcript and its checkpoint references (R15.6, R10.5)", async () => {
    await client().listMessages("s1");
    expect(callArgs()[0]).toBe("http://127.0.0.1:8712/v1/sessions/s1/messages");

    fetchMock.mockClear();
    await client().listCheckpoints("s1");
    expect(callArgs()[0]).toBe("http://127.0.0.1:8712/v1/sessions/s1/agent/checkpoints");
  });

  it("percent-encodes a mention query rather than pasting it into the URL (R12.1)", async () => {
    await client().searchContext("s1", "src/a b?c&d", 5);
    expect(callArgs()[0]).toBe(
      "http://127.0.0.1:8712/v1/sessions/s1/context/search?q=src%2Fa%20b%3Fc%26d&limit=5",
    );
  });

  it("uses PUT for the index config and PATCH for settings, as the gateway does", async () => {
    await client().updateIndexConfig("s1", { include: [] } as never);
    expect(callArgs()[1].method).toBe("PUT");

    fetchMock.mockClear();
    await client().updateSettings({} as never);
    expect(callArgs()[1].method).toBe("PATCH");
  });

  it("sends the terminal's control calls with the PTY defaults filled in", async () => {
    await client().spawnTerminal("bash", { cwd: "/work/proj" });
    const [url, init] = callArgs();
    expect(url).toBe("http://127.0.0.1:8712/v1/terminal");
    expect(JSON.parse(String(init.body))).toEqual({
      cmd: "bash",
      args: [],
      cwd: "/work/proj",
      cols: 120,
      rows: 32,
    });
  });

  it("sets a JSON content type on a body-carrying request and on nothing else", async () => {
    await client().indexRebuild("s1");
    const withoutBody = new Headers(callArgs()[1].headers);
    expect(withoutBody.has("content-type")).toBe(false);

    fetchMock.mockClear();
    await client().writeTerminal("t1", "ls\n");
    const withBody = new Headers(callArgs()[1].headers);
    expect(withBody.get("content-type")).toBe("application/json");
  });

  it("resolves a 204 to undefined instead of failing to parse an empty body", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.reject(new Error("no body")),
    } as unknown as Response);

    await expect(client().deleteSession("s1")).resolves.toBeUndefined();
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: failures keep their envelope", () => {
  it("throws with the parsed body attached, so normalizeError keeps code and retryable", async () => {
    const body = {
      detail: {
        code: "index_unavailable",
        message: "The context index is still building.",
        details: null,
        retryable: true,
      },
    };
    fetchMock.mockResolvedValue(failure(503, body));

    const error = await makeWorkspaceServicesClient(8712)
      .indexStatus("s1")
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(WorkspaceServicesRequestError);
    const request = error as WorkspaceServicesRequestError;
    expect(request.status).toBe(503);
    expect(request.body).toEqual(body);
    // The point of carrying the body: flattening to a string here would lose
    // `retryable`, and `retryable` is what every retry affordance reads (R16.6).
    const normalized = normalizeError(request.body);
    expect(normalized.code).toBe("index_unavailable");
    expect(normalized.retryable).toBe(true);
    expect(normalized.message).toBe("The context index is still building.");
  });

  it("prefers the body's sentence to a generic one, and falls back when there is none", async () => {
    fetchMock.mockResolvedValue(failure(404, { detail: "Session not found" }));
    const withDetail = await makeWorkspaceServicesClient(8712)
      .getSession("missing")
      .catch((thrown: unknown) => thrown);
    expect((withDetail as Error).message).toBe("Session not found");

    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: () => Promise.resolve(""),
      json: () => Promise.reject(new Error("no body")),
    } as unknown as Response);
    const withoutBody = await makeWorkspaceServicesClient(8712)
      .getSession("s1")
      .catch((thrown: unknown) => thrown);
    expect((withoutBody as Error).message).toContain("http 500");
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: one endpoint resolution", () => {
  it("shares the in-flight resolution across concurrent callers", async () => {
    const [a, b, c] = await Promise.all([
      getWorkspaceServicesClient(),
      getWorkspaceServicesClient(),
      getWorkspaceServicesClient(),
    ]);

    // A panel mount fires several of these at once. Resolving per caller would
    // mean three 30-second readiness polls racing on a cold start.
    expect(endpoint.resolveWorkspaceServicesEndpoint).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(workspaceServicesEndpoint()?.port).toBe(8712);
  });

  it("re-resolves after a reset, which is what a moved sidecar port needs", async () => {
    await getWorkspaceServicesClient();
    resetWorkspaceServicesClient();
    expect(workspaceServicesEndpoint()).toBeNull();

    endpoint.resolveWorkspaceServicesEndpoint.mockResolvedValue({
      port: 8899,
      baseUrl: "http://127.0.0.1:8899",
    });
    const moved = await getWorkspaceServicesClient();

    expect(moved.port).toBe(8899);
    expect(endpoint.resolveWorkspaceServicesEndpoint).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed resolution", async () => {
    endpoint.resolveWorkspaceServicesEndpoint.mockRejectedValueOnce(new Error("not ready"));

    await expect(getWorkspaceServicesClient()).rejects.toThrow("not ready");

    // The retry is the whole point: a client cached from a failed resolve would
    // make the sidecar's slow start permanent for the session.
    const second = await getWorkspaceServicesClient();
    expect(second.port).toBe(8712);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 22.1: the retired surface stays retired", () => {
  it("exposes no provider call, no slash command, and no SSE helper (R6.2, R6.3)", () => {
    const surface = makeWorkspaceServicesClient(8712) as unknown as Record<string, unknown>;

    // Each of these moved or was retired. A reappearance here is a renderer path
    // back to a provider call on the Python side (R6.2) or to a stream that is not
    // the custom transport's (R6.5) — both regressions the client exists to prevent.
    for (const retired of [
      "runSlashCommand",
      "listSlashCommands",
      "codeReview",
      "inlineEdit",
      "testGen",
      "testRun",
      "listProviders",
      "discoverModels",
      "listTools",
      "listPermissions",
      "setPermissions",
      "listToolGrants",
      "setToolGrants",
      "hardware",
      "memoryStats",
      "compactMemory",
      "forgetMemory",
      "contextStatus",
      "terminalStream",
      "applyRun",
      "restoreRun",
      "discardRun",
    ]) {
      expect(surface[retired], `${retired} must not be on the client`).toBeUndefined();
    }
  });
});
