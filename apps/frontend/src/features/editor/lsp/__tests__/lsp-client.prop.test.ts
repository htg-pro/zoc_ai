// Feature: monaco-lsp-integration, Property 7: Single language client per server
import { beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const resolveAgentPort = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-port", () => ({ resolveAgentPort }));

import { createLspClient, type ManagedLanguageClient } from "../lsp-client";
import type { LspSocket } from "../lsp-connection";
import type { ServerName } from "../lsp-registry";

const SERVERS: ServerName[] = ["typescript-language-server", "pyright", "rust-analyzer"];

/** A fake socket that auto-fires `onopen` as a microtask once the connection
 *  assigns its handler, so the client builds deterministically after a flush. */
class AutoOpenSocket implements LspSocket {
  private _onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
  get onopen(): (() => void) | null {
    return this._onopen;
  }
  set onopen(handler: (() => void) | null) {
    this._onopen = handler;
    if (handler) queueMicrotask(() => this._onopen?.());
  }
}

interface FakeClient extends ManagedLanguageClient {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}

/** Drain all pending microtasks (the whole start→connect→build→start chain). */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  resolveAgentPort.mockReset();
  resolveAgentPort.mockResolvedValue(9999);
});

describe("lsp-client", () => {
  it("Property 7: at most one client per server; one build per start-transition", async () => {
    const opsArb = fc.array(
      fc.record({
        op: fc.constantFrom("start", "stop"),
        server: fc.constantFrom(...SERVERS),
      }),
      { maxLength: 24 },
    );

    await fc.assert(
      fc.asyncProperty(opsArb, async (ops) => {
        const built = new Map<ServerName, FakeClient[]>();
        const client = createLspClient({
          ensureServicesInitialized: () => {},
          onServerState: () => {},
          onServerRemoved: () => {},
          socketFactory: () => new AutoOpenSocket(),
          createLanguageClient: ({ server }) => {
            const fake: FakeClient = {
              start: vi.fn(),
              stop: vi.fn().mockResolvedValue(undefined),
              dispose: vi.fn(),
            };
            const list = built.get(server) ?? [];
            list.push(fake);
            built.set(server, list);
            return fake;
          },
        });

        // Simulate the expected running set + build count (a build happens only
        // on a not-running → running transition; start on a running server is a
        // no-op, so at most one client exists per server at a time).
        const expectedRunning = new Set<ServerName>();
        const expectedBuilds = new Map<ServerName, number>();
        for (const { op, server } of ops) {
          if (op === "start") {
            if (!expectedRunning.has(server)) {
              expectedRunning.add(server);
              expectedBuilds.set(server, (expectedBuilds.get(server) ?? 0) + 1);
            }
            client.start(server);
          } else {
            expectedRunning.delete(server);
            client.stop(server);
          }
          await flush(); // let each op's async chain settle before the next
        }
        await flush();

        // Running set matches exactly (singleton set, ≤1 per Server_Name).
        expect([...client.runningServers()].sort()).toEqual([...expectedRunning].sort());
        // Exactly one client built per start-transition per server.
        for (const server of SERVERS) {
          expect(built.get(server)?.length ?? 0).toBe(expectedBuilds.get(server) ?? 0);
        }
        // Every currently-running server's latest client is live (not disposed);
        // every other built client has been disposed.
        for (const server of SERVERS) {
          const list = built.get(server) ?? [];
          list.forEach((c, i) => {
            const isCurrentLive = expectedRunning.has(server) && i === list.length - 1;
            if (isCurrentLive) {
              expect(c.dispose).not.toHaveBeenCalled();
            } else {
              expect(c.dispose).toHaveBeenCalled();
            }
          });
        }

        // Tear down anything still running.
        for (const server of client.runningServers()) client.stop(server);
        await flush();
      }),
      { numRuns: 50 },
    );
  });

  it("stop() stops then disposes the built client, and removes it (R3.4/R5.6)", async () => {
    const order: string[] = [];
    const removed: ServerName[] = [];
    const fake: FakeClient = {
      start: vi.fn(),
      stop: vi.fn(() => {
        order.push("stop");
        return Promise.resolve();
      }),
      dispose: vi.fn(() => {
        order.push("dispose");
      }),
    };
    const client = createLspClient({
      ensureServicesInitialized: () => {},
      onServerState: () => {},
      onServerRemoved: (s) => removed.push(s),
      socketFactory: () => new AutoOpenSocket(),
      createLanguageClient: () => fake,
    });

    client.start("pyright");
    await flush();
    expect(fake.start).toHaveBeenCalledTimes(1); // built + started on open
    expect(client.runningServers().has("pyright")).toBe(true);

    client.stop("pyright");
    await flush();
    expect(order).toEqual(["stop", "dispose"]); // stop before dispose
    expect(removed).toEqual(["pyright"]);
    expect(client.runningServers().has("pyright")).toBe(false);
  });

  it("start() is a no-op for an already-running server (R3.5 singleton)", async () => {
    let builds = 0;
    const client = createLspClient({
      ensureServicesInitialized: () => {},
      onServerState: () => {},
      onServerRemoved: () => {},
      socketFactory: () => new AutoOpenSocket(),
      createLanguageClient: () => {
        builds += 1;
        return { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() };
      },
    });
    client.start("rust-analyzer");
    client.start("rust-analyzer");
    client.start("rust-analyzer");
    await flush();
    expect(builds).toBe(1);
    expect([...client.runningServers()]).toEqual(["rust-analyzer"]);
    client.stop("rust-analyzer");
    await flush();
  });
});
