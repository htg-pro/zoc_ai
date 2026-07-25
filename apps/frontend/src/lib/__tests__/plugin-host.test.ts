// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, test } from "vitest";

interface WorkerHarness {
  messages: Array<Record<string, unknown>>;
  send(message: Record<string, unknown>): Promise<void>;
}

function createWorkerHarness(): WorkerHarness {
  const messages: Array<Record<string, unknown>> = [];
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => unknown>>();
  const sandbox: Record<string, unknown> = {
    postMessage: (message: Record<string, unknown>) => messages.push(message),
    addEventListener: (type: string, listener: (event: Record<string, unknown>) => unknown) => {
      const current = listeners.get(type) ?? [];
      current.push(listener);
      listeners.set(type, current);
    },
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: () => Promise.reject(new Error("network should be blocked")),
    WebSocket: class {},
    XMLHttpRequest: class {},
  };
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  const source = readFileSync(new URL("../../../public/plugin-host.js", import.meta.url), "utf8");
  vm.runInContext(source, context, { filename: "plugin-host.js" });

  return {
    messages,
    async send(message) {
      const messageListeners = listeners.get("message") ?? [];
      for (const listener of messageListeners) {
        await listener({ data: message });
      }
    },
  };
}

function lastMessage(harness: WorkerHarness, type: string): Record<string, unknown> | undefined {
  return [...harness.messages].reverse().find((message) => message.type === type);
}

describe("plugin worker host", () => {
  test("hides direct globals, awaits activation, and registers validated handlers", async () => {
    const worker = createWorkerHarness();
    await worker.send({
      type: "load",
      pluginId: "safe.plugin",
      code: `
        if (typeof fetch !== "undefined" || typeof self !== "undefined" || typeof postMessage !== "undefined") {
          throw new Error("unsafe global exposed");
        }
        if (({}).constructor.constructor !== undefined) throw new Error("constructor escape exposed");
        zoc.commands.register("safe.plugin.run", async () => Promise.resolve());
        return Promise.resolve();
      `,
    });

    expect(worker.messages).toContainEqual({
      type: "register-command",
      pluginId: "safe.plugin",
      commandId: "safe.plugin.run",
    });
    expect(lastMessage(worker, "ready")).toEqual({ type: "ready", pluginId: "safe.plugin" });

    await worker.send({ type: "invoke", callId: 1, commandId: "safe.plugin.run" });
    expect(lastMessage(worker, "invoke-result")).toEqual({
      type: "invoke-result",
      callId: 1,
      ok: true,
    });
  });

  test("reports missing and rejected command handlers through invoke-result", async () => {
    const missing = createWorkerHarness();
    await missing.send({ type: "load", pluginId: "missing", code: "return Promise.resolve();" });
    await missing.send({ type: "invoke", callId: 2, commandId: "missing.run" });
    expect(lastMessage(missing, "invoke-result")).toMatchObject({
      callId: 2,
      ok: false,
      error: "No handler registered for missing.run",
    });

    const rejected = createWorkerHarness();
    await rejected.send({
      type: "load",
      pluginId: "rejected",
      code: `zoc.commands.register("rejected.run", async () => { throw new Error("boom"); });`,
    });
    await rejected.send({ type: "invoke", callId: 3, commandId: "rejected.run" });
    expect(lastMessage(rejected, "invoke-result")).toMatchObject({
      callId: 3,
      ok: false,
      error: "boom",
    });
  });

  test("rejects direct dynamic imports before plugin evaluation", async () => {
    const worker = createWorkerHarness();
    await worker.send({
      type: "load",
      pluginId: "network.plugin",
      code: `return import("https://example.invalid/plugin.js");`,
    });

    expect(lastMessage(worker, "error")).toMatchObject({
      pluginId: "network.plugin",
      message: "Plugin code may not import external modules.",
    });
    expect(lastMessage(worker, "ready")).toBeUndefined();
  });
});
