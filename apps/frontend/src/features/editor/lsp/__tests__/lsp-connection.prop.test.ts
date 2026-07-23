// Feature: monaco-lsp-integration, Property 1: Connection URL
// Feature: monaco-lsp-integration, Property 2: Reconnect backoff schedule
// Feature: monaco-lsp-integration, Property 3: Disposal is authoritative
// Feature: monaco-lsp-integration, Property 4: Close-code policy
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";

const resolveAgentPort = vi.hoisted(() => vi.fn());
vi.mock("@/lib/agent-port", () => ({ resolveAgentPort }));

import {
  ABNORMAL_SERVER_TERMINATION_CLOSE_CODE,
  INITIAL_RECONNECT_MS,
  MAX_RECONNECT_MS,
  SERVER_NOT_INSTALLED_CLOSE_CODE,
  lspConnectionUrl,
  openLspConnection,
  type LanguageServerState,
  type LspSocket,
} from "../lsp-connection";

/** A transient (non-application) close code — drives backoff reconnect. */
const TRANSIENT_CLOSE_CODE = 1006;
const SERVERS = ["typescript-language-server", "pyright", "rust-analyzer"] as const;

class FakeSocket implements LspSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}

function makeHarness() {
  const sockets: FakeSocket[] = [];
  const states: LanguageServerState[] = [];
  const factory = (): LspSocket => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  };
  return { sockets, states, factory };
}

beforeEach(() => {
  resolveAgentPort.mockReset();
  resolveAgentPort.mockResolvedValue(9999);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("lsp-connection", () => {
  it("Property 1: Connection URL — opens ws://127.0.0.1:{port}/v1/lsp/{server}/ws", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 65535 }),
        fc.constantFrom(...SERVERS),
        async (port, server) => {
          resolveAgentPort.mockResolvedValue(port);
          const opened: string[] = [];
          const conn = await openLspConnection(server, {
            onOpen: () => {},
            onClose: () => {},
            onState: () => {},
            socketFactory: (url) => {
              opened.push(url);
              return new FakeSocket();
            },
          });
          expect(opened).toEqual([`ws://127.0.0.1:${port}/v1/lsp/${server}/ws`]);
          expect(opened[0]).toBe(lspConnectionUrl(port, server));
          conn.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 2: Reconnect backoff schedule — 500, min(2×prev, 5000), reconnect fires at exactly that delay", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (numCloses) => {
        vi.useFakeTimers();
        const { sockets, factory } = makeHarness();
        resolveAgentPort.mockResolvedValue(9999);
        const conn = await openLspConnection("pyright", {
          onOpen: () => {},
          onClose: () => {},
          onState: () => {},
          socketFactory: factory,
        });
        expect(sockets.length).toBe(1);
        let expectedDelay = INITIAL_RECONNECT_MS;
        for (let i = 0; i < numCloses; i++) {
          const before = sockets.length;
          sockets[sockets.length - 1].onclose?.({ code: TRANSIENT_CLOSE_CODE });
          // Not yet reconnected 1ms before the scheduled delay…
          await vi.advanceTimersByTimeAsync(expectedDelay - 1);
          expect(sockets.length).toBe(before);
          // …and reconnects exactly at the delay.
          await vi.advanceTimersByTimeAsync(1);
          expect(sockets.length).toBe(before + 1);
          expectedDelay = Math.min(MAX_RECONNECT_MS, expectedDelay * 2);
        }
        conn.dispose();
      }),
      { numRuns: 60 },
    );
  });

  it("Property 2 (reset): a successful open resets the next reconnect delay to 500ms", async () => {
    vi.useFakeTimers();
    const { sockets, factory } = makeHarness();
    const conn = await openLspConnection("pyright", {
      onOpen: () => {},
      onClose: () => {},
      onState: () => {},
      socketFactory: factory,
    });
    // Grow the delay via two closes (500 → 1000 → next would be 2000).
    sockets[sockets.length - 1].onclose?.({ code: TRANSIENT_CLOSE_CODE });
    await vi.advanceTimersByTimeAsync(INITIAL_RECONNECT_MS);
    sockets[sockets.length - 1].onclose?.({ code: TRANSIENT_CLOSE_CODE });
    await vi.advanceTimersByTimeAsync(INITIAL_RECONNECT_MS * 2);
    // Open the current socket → resets delay back to 500.
    sockets[sockets.length - 1].onopen?.();
    const before = sockets.length;
    sockets[sockets.length - 1].onclose?.({ code: TRANSIENT_CLOSE_CODE });
    await vi.advanceTimersByTimeAsync(INITIAL_RECONNECT_MS - 1);
    expect(sockets.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets.length).toBe(before + 1);
    conn.dispose();
  });

  it("Property 3: Disposal is authoritative — no socket opens and no timer survives after dispose", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.boolean(),
        fc.array(fc.constantFrom("close", "tick"), { maxLength: 12 }),
        async (closeBeforeDispose, events) => {
          vi.useFakeTimers();
          const { sockets, factory } = makeHarness();
          const conn = await openLspConnection("rust-analyzer", {
            onOpen: () => {},
            onClose: () => {},
            onState: () => {},
            socketFactory: factory,
          });
          const first = sockets[0];
          if (closeBeforeDispose) {
            // Schedules a reconnect timer and nulls the current socket.
            first.onclose?.({ code: TRANSIENT_CLOSE_CODE });
          }
          conn.dispose();
          if (!closeBeforeDispose) {
            // dispose() closes the live current socket.
            expect(first.close).toHaveBeenCalled();
          }
          const countAfterDispose = sockets.length;
          for (const e of events) {
            if (e === "close") sockets[sockets.length - 1]?.onclose?.({ code: TRANSIENT_CLOSE_CODE });
            else await vi.advanceTimersByTimeAsync(MAX_RECONNECT_MS);
          }
          // No further socket was ever opened after disposal.
          expect(sockets.length).toBe(countAfterDispose);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Property 4: Close-code policy — abnormal→backoff+starting, not-installed→no-reconnect+error, dispose→nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("abnormal", "notinstalled", "dispose"),
        async (kind) => {
          vi.useFakeTimers();
          const { sockets, states, factory } = makeHarness();
          const conn = await openLspConnection("pyright", {
            onOpen: () => {},
            onClose: () => {},
            onState: (s) => states.push(s),
            socketFactory: factory,
          });
          sockets[0].onopen?.(); // establish the connection first
          const before = sockets.length;
          if (kind === "abnormal") {
            sockets[0].onclose?.({ code: ABNORMAL_SERVER_TERMINATION_CLOSE_CODE });
            expect(states[states.length - 1]).toBe("starting");
            await vi.advanceTimersByTimeAsync(INITIAL_RECONNECT_MS);
            expect(sockets.length).toBe(before + 1); // reconnected with backoff
          } else if (kind === "notinstalled") {
            sockets[0].onclose?.({ code: SERVER_NOT_INSTALLED_CLOSE_CODE });
            expect(states[states.length - 1]).toBe("error");
            await vi.advanceTimersByTimeAsync(MAX_RECONNECT_MS);
            expect(sockets.length).toBe(before); // no reconnect
          } else {
            conn.dispose();
            await vi.advanceTimersByTimeAsync(MAX_RECONNECT_MS);
            expect(sockets.length).toBe(before); // no new socket opened
          }
          conn.dispose();
        },
      ),
      { numRuns: 100 },
    );
  });
});
