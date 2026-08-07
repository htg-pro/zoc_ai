import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMcpServers, reloadMcp, testMcpServer, updateMcpTool } from "../mcp-client";

vi.mock("../runtime-endpoint", () => ({
  resolveRuntimeEndpoint: () =>
    Promise.resolve({ port: 3011, token: "runtime-secret", baseUrl: "http://127.0.0.1:3011" }),
  runtimeAuthHeaders: () => ({ authorization: "Bearer runtime-secret" }),
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, ok = true): void {
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    void url;
    void init;
    return {
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

test("fetchMcpServers unwraps the servers array from the loopback route", async () => {
  const servers = [
    {
      id: "web-search",
      transport: "stdio",
      scope: "workspace",
      disabled: false,
      autoApprove: ["web_search"],
      status: "running",
      errorReason: null,
    },
  ];
  mockFetch({ servers });
  await expect(fetchMcpServers()).resolves.toEqual(servers);
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:3011/v1/mcp/servers");
  expect(new Headers((call[1] as RequestInit).headers).get("authorization")).toBe(
    "Bearer runtime-secret",
  );
});

test("reloadMcp posts to /reload and returns the servers", async () => {
  mockFetch({ servers: [] });
  await expect(reloadMcp()).resolves.toEqual([]);
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:3011/v1/mcp/reload");
  expect((call[1] as RequestInit).method).toBe("POST");
  expect(new Headers((call[1] as RequestInit).headers).get("authorization")).toBe(
    "Bearer runtime-secret",
  );
});

test("updates one runtime tool with bearer authentication", async () => {
  mockFetch({
    tool: {
      name: "mcp__s__t",
      serverId: "s",
      bareName: "t",
      enabled: false,
      capability: "execute",
    },
  });
  await expect(updateMcpTool("mcp__s__t", { enabled: false })).resolves.toMatchObject({
    enabled: false,
  });
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:3011/v1/mcp/tools/mcp__s__t");
  expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ enabled: false });
  expect(new Headers((call[1] as RequestInit).headers).get("authorization")).toBe(
    "Bearer runtime-secret",
  );
});

test("testMcpServer posts the candidate and returns the typed outcome", async () => {
  mockFetch({ outcome: "success", toolCount: 2, bareNames: ["a", "b"] });
  const result = await testMcpServer({ id: "x", command: "cmd" });
  expect(result).toEqual({ outcome: "success", toolCount: 2, bareNames: ["a", "b"] });
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:3011/v1/mcp/test");
  expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ id: "x", command: "cmd" });
  expect(new Headers((call[1] as RequestInit).headers).get("authorization")).toBe(
    "Bearer runtime-secret",
  );
});

test("fetchMcpServers rejects on a non-ok response", async () => {
  mockFetch({}, false);
  await expect(fetchMcpServers()).rejects.toThrow(/mcp servers request failed/);
});
