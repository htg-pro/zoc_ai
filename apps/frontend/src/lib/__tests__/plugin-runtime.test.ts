import { test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createDefaultPluginSandbox,
  initPluginRuntime,
  reconcilePlugins,
  runPluginTerminalCommand,
} from "../plugin-runtime";
import type { HostMessage, PluginSandbox, SandboxWorker, WorkerMessage } from "../plugins-sandbox";
import {
  __resetPluginHostForTests,
  getPlugin,
  installPlugin,
  registerPluginCommand,
  setPluginEnabled,
} from "../plugins";
import { __resetTrustForTests, setRunMode, setTrust } from "../trust";
import { getCommand } from "../commands";

const realLocalStorage = globalThis.localStorage;

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

class FakeSandbox implements PluginSandbox {
  loaded: Array<[string, string]> = [];
  stopped: string[] = [];
  invoked: Array<[string, string]> = [];
  private live = new Set<string>();
  load(id: string, code: string): void {
    this.loaded.push([id, code]);
    this.live.add(id);
    for (const command of getPlugin(id)?.manifest.contributes.commands ?? []) {
      registerPluginCommand(id, command.id);
    }
  }
  invokeCommand(id: string, commandId: string): void {
    this.invoked.push([id, commandId]);
  }
  stop(id: string): void {
    this.stopped.push(id);
    this.live.delete(id);
  }
  stopAll(): void {
    for (const id of [...this.live]) this.stop(id);
  }
  running(): ReadonlySet<string> {
    return new Set(this.live);
  }
}

const CODED_PLUGIN = {
  id: "coded",
  name: "Coded",
  version: "1.0.0",
  contributes: { commands: [{ id: "coded.hello", title: "Hello" }] },
};
const CODE = "zoc.commands.register('coded.hello', function(){});";

beforeEach(() => {
  vi.stubGlobal("localStorage", fakeStorage());
  __resetPluginHostForTests();
  __resetTrustForTests();
  setTrust("trusted");
  setRunMode("all"); // plugin command execution is allowed
});
afterEach(() => {
  vi.stubGlobal("localStorage", realLocalStorage);
  __resetPluginHostForTests();
  __resetTrustForTests();
});

test("reconcilePlugins loads new desired, stops removed, keeps running", () => {
  const plan = reconcilePlugins(
    new Set(["a", "b"]),
    new Map([
      ["b", "codeB"],
      ["c", "codeC"],
    ]),
  );
  expect(plan.load).toEqual([["c", "codeC"]]);
  expect(plan.stop).toEqual(["a"]);
});

test("initPluginRuntime loads enabled coded plugins and reconciles on change", () => {
  installPlugin(CODED_PLUGIN, "zip", CODE);
  const sandbox = new FakeSandbox();
  const dispose = initPluginRuntime(sandbox);

  expect(sandbox.loaded).toContainEqual(["coded", CODE]); // loaded on init

  setPluginEnabled("coded", false); // disable → reconcile stops the worker
  expect(sandbox.stopped).toContain("coded");

  dispose();
});

test("a contributed command invokes the sandbox handler through the invoker", () => {
  installPlugin(CODED_PLUGIN, "zip", CODE);
  const sandbox = new FakeSandbox();
  const dispose = initPluginRuntime(sandbox);

  getCommand("coded.hello")?.run();
  expect(sandbox.invoked).toContainEqual(["coded", "coded.hello"]);
  dispose();
});

test("a restricted workspace blocks command invocation (no sandbox call)", () => {
  installPlugin(CODED_PLUGIN, "zip", CODE);
  const sandbox = new FakeSandbox();
  const dispose = initPluginRuntime(sandbox);

  setTrust("restricted"); // plugin execution is denied by the permission engine
  getCommand("coded.hello")?.run();
  expect(sandbox.invoked).toEqual([]); // gated: never routed to the worker
  dispose();
});

test("same-id code updates stop and reload the worker", () => {
  installPlugin(CODED_PLUGIN, "zip", CODE);
  const sandbox = new FakeSandbox();
  const dispose = initPluginRuntime(sandbox);
  const revisedCode = `${CODE}\n// revision two`;

  installPlugin({ ...CODED_PLUGIN, version: "1.1.0" }, "zip", revisedCode);

  expect(sandbox.stopped).toContain("coded");
  expect(sandbox.loaded).toContainEqual(["coded", revisedCode]);
  expect(getCommand("coded.hello")).toBeDefined();
  dispose();
});

test("dispose detaches the invoker and stops all workers", () => {
  installPlugin(CODED_PLUGIN, "zip", CODE);
  const sandbox = new FakeSandbox();
  const dispose = initPluginRuntime(sandbox);
  dispose();
  expect(sandbox.stopped).toContain("coded");
  // After dispose the invoker is detached, so a command run routes nowhere.
  sandbox.invoked = [];
  getCommand("coded.hello")?.run();
  expect(sandbox.invoked).toEqual([]);
});

test("plugin terminal execution uses shell argv, bounds output, and cleans up", async () => {
  const spawnTerminal = vi.fn(async () => ({ id: "term-1" }));
  const stopTerminal = vi.fn(async () => ({ id: "term-1" }));
  const terminalStream = vi.fn(async function* () {
    yield { type: "data" as const, chunk: "x".repeat(500) };
    yield { type: "exit" as const, code: 0 };
  });

  const output = await runPluginTerminalCommand("printf test", {
    client: { spawnTerminal, stopTerminal, terminalStream } as never,
    platform: "unix",
    cwd: "/workspace",
    maxOutputChars: 128,
  });

  expect(spawnTerminal).toHaveBeenCalledWith("/bin/sh", {
    args: ["-lc", "printf test"],
    cwd: "/workspace",
    cols: 120,
    rows: 30,
  });
  expect(output).toHaveLength(128);
  expect(output).toContain("[plugin output truncated]");
  expect(stopTerminal).toHaveBeenCalledWith("term-1");
});

test("plugin terminal timeout aborts the stream and stops the backend", async () => {
  const spawnTerminal = vi.fn(async () => ({ id: "term-timeout" }));
  const stopTerminal = vi.fn(async () => ({ id: "term-timeout" }));
  const terminalStream = vi.fn(async function* (_id: string, signal?: AbortSignal) {
    await new Promise<void>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), {
        once: true,
      });
    });
  });

  await expect(
    runPluginTerminalCommand("sleep forever", {
      client: { spawnTerminal, stopTerminal, terminalStream } as never,
      timeoutMs: 5,
    }),
  ).rejects.toThrow("timed out");
  expect(stopTerminal).toHaveBeenCalledWith("term-timeout");
});

test("default plugin storage namespaces values by the owning worker", async () => {
  class BridgeWorker implements SandboxWorker {
    static instances: BridgeWorker[] = [];
    posted: HostMessage[] = [];
    onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
    onerror: ((event: { message?: string }) => void) | null = null;
    constructor() {
      BridgeWorker.instances.push(this);
    }
    postMessage(message: HostMessage): void {
      this.posted.push(message);
      if (message.type === "load") {
        this.onmessage?.({ data: { type: "ready", pluginId: message.pluginId } });
      }
    }
    terminate(): void {}
    emit(message: WorkerMessage): void {
      this.onmessage?.({ data: message });
    }
  }

  const originalWorker = globalThis.Worker;
  vi.stubGlobal("Worker", BridgeWorker as unknown as typeof Worker);
  try {
    const sandbox = createDefaultPluginSandbox(async () => "");
    sandbox.load("plugin.one", "code");
    sandbox.load("plugin.two", "code");
    const [one, two] = BridgeWorker.instances;
    one.emit({
      type: "api-request",
      pluginId: "spoofed",
      reqId: 1,
      api: "storage",
      method: "set",
      args: ["shared", "one"],
    });
    two.emit({
      type: "api-request",
      pluginId: "spoofed",
      reqId: 2,
      api: "storage",
      method: "set",
      args: ["shared", "two"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    one.posted.length = 0;
    two.posted.length = 0;

    one.emit({
      type: "api-request",
      pluginId: "plugin.two",
      reqId: 3,
      api: "storage",
      method: "get",
      args: ["shared"],
    });
    two.emit({
      type: "api-request",
      pluginId: "plugin.one",
      reqId: 4,
      api: "storage",
      method: "get",
      args: ["shared"],
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(one.posted).toContainEqual({ type: "api-response", reqId: 3, ok: true, value: "one" });
    expect(two.posted).toContainEqual({ type: "api-response", reqId: 4, ok: true, value: "two" });
    sandbox.stopAll();
  } finally {
    vi.stubGlobal("Worker", originalWorker);
  }
});
