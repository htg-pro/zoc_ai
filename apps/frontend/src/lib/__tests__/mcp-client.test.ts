import { test, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMcpServers, reloadMcp, testMcpServer } from "../mcp-client";

vi.mock("../agent-port", () => ({ resolveAgentPort: () => Promise.resolve(1234) }));

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
    { id: "web-search", transport: "stdio", scope: "workspace", disabled: false, autoApprove: ["web_search"], status: "running", errorReason: null },
  ];
  mockFetch({ servers });
  await expect(fetchMcpServers()).resolves.toEqual(servers);
  expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:1234/v1/mcp/servers");
});

test("reloadMcp posts to /reload and returns the servers", async () => {
  mockFetch({ servers: [] });
  await expect(reloadMcp()).resolves.toEqual([]);
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:1234/v1/mcp/reload");
  expect((call[1] as RequestInit).method).toBe("POST");
});

test("testMcpServer posts the candidate and returns the typed outcome", async () => {
  mockFetch({ outcome: "success", toolCount: 2, bareNames: ["a", "b"] });
  const result = await testMcpServer({ id: "x", command: "cmd" });
  expect(result).toEqual({ outcome: "success", toolCount: 2, bareNames: ["a", "b"] });
  const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(call[0]).toBe("http://127.0.0.1:1234/v1/mcp/test");
  expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ id: "x", command: "cmd" });
});

test("fetchMcpServers rejects on a non-ok response", async () => {
  mockFetch({}, false);
  await expect(fetchMcpServers()).rejects.toThrow(/mcp servers request failed/);
});
