import { test, expect } from "vitest";
import fc from "fast-check";
import {
  createPluginSandbox,
  resolveApiRequest,
  type HostMessage,
  type SandboxDeps,
  type SandboxWorker,
  type WorkerMessage,
} from "../plugins-sandbox";
import type { Effect } from "../permissions-engine";

class FakeWorker implements SandboxWorker {
  posted: HostMessage[] = [];
  terminated = false;
  onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;

  postMessage(message: HostMessage): void {
    this.posted.push(message);
    if (message.type === "load") {
      this.onmessage?.({ data: { type: "ready", pluginId: message.pluginId } });
    }
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(message: WorkerMessage): void {
    this.onmessage?.({ data: message });
  }
  emitError(message: string): void {
    this.onerror?.({ message });
  }
}

function makeDeps(overrides: Partial<SandboxDeps> = {}): {
  deps: SandboxDeps;
  created: Map<string, FakeWorker>;
  registered: Array<[string, string]>;
  errored: Array<[string, string]>;
} {
  const created = new Map<string, FakeWorker>();
  const registered: Array<[string, string]> = [];
  const errored: Array<[string, string]> = [];
  const deps: SandboxDeps = {
    workerFactory: (id) => {
      const w = new FakeWorker();
      created.set(id, w);
      return w;
    },
    checkTerminalPermission: () => ({ effect: "allow", reason: "" }),
    runTerminal: async (cmd) => `ran:${cmd}`,
    editor: { getText: () => "TEXT", setText: () => {}, getSelection: () => "SEL" },
    storage: { get: () => "V", set: () => {} },
    ui: { showMessage: () => {} },
    onRegisterCommand: (p, c) => registered.push([p, c]),
    onError: (p, m) => errored.push([p, m]),
    ...overrides,
  };
  return { deps, created, registered, errored };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// Feature: plugin-system, Property 1: One worker per plugin
test("one worker per plugin; stop terminates it", () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom("a", "b", "c", "d"), { maxLength: 8 }), (ids) => {
      const { deps, created } = makeDeps();
      const sandbox = createPluginSandbox(deps);
      ids.forEach((id) => sandbox.load(id, "code"));
      const distinct = new Set(ids);
      expect(sandbox.running()).toEqual(distinct);
      expect(created.size).toBe(distinct.size); // exactly one worker per distinct id
      for (const w of created.values()) {
        expect(w.posted.filter((m) => m.type === "load")).toHaveLength(1);
      }
      distinct.forEach((id) => sandbox.stop(id));
      expect(sandbox.running().size).toBe(0);
      for (const w of created.values()) expect(w.terminated).toBe(true);
    }),
    { numRuns: 200 },
  );
});

// Feature: plugin-system, Property 2: API requests round-trip by id
test("an api-request yields exactly one api-response with the same reqId", async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 99999 }), async (reqId) => {
      const { deps, created } = makeDeps();
      const sandbox = createPluginSandbox(deps);
      sandbox.load("p", "code");
      const w = created.get("p")!;
      w.posted.length = 0;
      w.emit({ type: "api-request", pluginId: "p", reqId, api: "editor", method: "getText", args: [] });
      await flush();
      const responses = w.posted.filter((m) => m.type === "api-response");
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({ type: "api-response", reqId, ok: true, value: "TEXT" });
    }),
    { numRuns: 100 },
  );
});

// Feature: plugin-system, Property 3: terminal.run is permission-gated
test("terminal.run runs iff the decision is allow", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<Effect>("allow", "deny", "prompt"),
      fc.string(),
      async (effect, cmd) => {
        const runs: string[] = [];
        const { deps } = makeDeps({
          checkTerminalPermission: () => ({ effect, reason: "" }),
          runTerminal: async (c) => {
            runs.push(c);
            return "out";
          },
        });
        const result = await resolveApiRequest(
          { type: "api-request", pluginId: "p", reqId: 1, api: "terminal", method: "run", args: [cmd] },
          deps,
        );
        if (effect === "allow") {
          expect(result).toEqual({ ok: true, value: "out" });
          expect(runs).toEqual([cmd]);
        } else {
          expect(result).toEqual({ ok: false, error: "permission denied" });
          expect(runs).toEqual([]); // never runs when not allowed
        }
      },
    ),
    { numRuns: 200 },
  );
});

// Feature: plugin-system, Property 4: Worker failure isolation
test("a failing worker is isolated; peers keep running", () => {
  fc.assert(
    fc.property(
      fc.uniqueArray(fc.constantFrom("a", "b", "c", "d"), { minLength: 2, maxLength: 4 }),
      fc.nat(),
      (ids, pick) => {
        const { deps, created, errored } = makeDeps();
        const sandbox = createPluginSandbox(deps);
        ids.forEach((id) => sandbox.load(id, "code"));
        const victim = ids[pick % ids.length];
        created.get(victim)!.emitError("boom");
        expect(errored).toContainEqual([victim, "boom"]);
        expect(created.get(victim)!.terminated).toBe(true);
        const survivors = ids.filter((id) => id !== victim);
        expect(sandbox.running()).toEqual(new Set(survivors));
        for (const id of survivors) expect(created.get(id)!.terminated).toBe(false);
      },
    ),
    { numRuns: 200 },
  );
});

// Feature: plugin-system, Property 5: Command invocation targets the owning worker
test("invokeCommand posts one invoke to the owning worker and none to others", () => {
  const { deps, created } = makeDeps();
  const sandbox = createPluginSandbox(deps);
  sandbox.load("a", "code");
  sandbox.load("b", "code");
  created.get("a")!.posted.length = 0;
  created.get("b")!.posted.length = 0;

  sandbox.invokeCommand("a", "cmd");
  const aInvokes = created.get("a")!.posted.filter((m) => m.type === "invoke");
  const bInvokes = created.get("b")!.posted.filter((m) => m.type === "invoke");
  expect(aInvokes).toHaveLength(1);
  expect(aInvokes[0]).toMatchObject({ type: "invoke", commandId: "cmd" });
  expect(bInvokes).toHaveLength(0);
  const callId = (aInvokes[0] as Extract<HostMessage, { type: "invoke" }>).callId;
  created.get("a")!.emit({ type: "invoke-result", callId, ok: true });

  // An unloaded plugin's command is not invocable (no throw, no post).
  expect(() => sandbox.invokeCommand("missing", "x")).not.toThrow();
});

test("register-command and denied terminal are surfaced correctly", async () => {
  const { deps, created, registered } = makeDeps({
    checkTerminalPermission: () => ({ effect: "deny", reason: "restricted" }),
  });
  const sandbox = createPluginSandbox(deps);
  sandbox.load("p", "code");
  const w = created.get("p")!;
  w.emit({ type: "register-command", pluginId: "p", commandId: "p.hello" });
  expect(registered).toContainEqual(["p", "p.hello"]);

  w.posted.length = 0;
  w.emit({ type: "api-request", pluginId: "p", reqId: 5, api: "terminal", method: "run", args: ["ls"] });
  await flush();
  const responses = w.posted.filter((m) => m.type === "api-response");
  expect(responses[0]).toMatchObject({ reqId: 5, ok: false, error: "permission denied" });
});


test("storage requests use the worker owner rather than a spoofed message identity", async () => {
  const reads: Array<[string, string]> = [];
  const { deps, created } = makeDeps({
    storage: {
      get: (pluginId, key) => {
        reads.push([pluginId, key]);
        return "owned";
      },
      set: () => {},
    },
  });
  const sandbox = createPluginSandbox(deps);
  sandbox.load("owner", "code");
  const worker = created.get("owner")!;
  worker.posted.length = 0;

  worker.emit({
    type: "api-request",
    pluginId: "victim",
    reqId: 7,
    api: "storage",
    method: "get",
    args: ["token"],
  });
  await flush();

  expect(reads).toEqual([["owner", "token"]]);
  expect(worker.posted).toContainEqual({
    type: "api-response",
    reqId: 7,
    ok: true,
    value: "owned",
  });
});

test("a rejected command handler terminates only its owning worker", () => {
  const { deps, created, errored } = makeDeps();
  const sandbox = createPluginSandbox(deps);
  sandbox.load("bad", "code");
  sandbox.load("peer", "code");
  sandbox.invokeCommand("bad", "bad.run");
  const invocation = created
    .get("bad")!
    .posted.find((message): message is Extract<HostMessage, { type: "invoke" }> =>
      message.type === "invoke",
    )!;

  created.get("bad")!.emit({
    type: "invoke-result",
    callId: invocation.callId,
    ok: false,
    error: "handler exploded",
  });

  expect(errored).toContainEqual(["bad", "command failed: handler exploded"]);
  expect(created.get("bad")!.terminated).toBe(true);
  expect(created.get("peer")!.terminated).toBe(false);
  expect(sandbox.running()).toEqual(new Set(["peer"]));
  sandbox.stopAll();
});

test("worker factory failures are reported without escaping or affecting peers", () => {
  const base = makeDeps();
  const peer = new FakeWorker();
  const deps: SandboxDeps = {
    ...base.deps,
    workerFactory: (pluginId) => {
      if (pluginId === "broken") throw new Error("constructor failed");
      return peer;
    },
  };
  const sandbox = createPluginSandbox(deps);
  sandbox.load("peer", "code");

  expect(() => sandbox.load("broken", "code")).not.toThrow();
  expect(base.errored).toContainEqual([
    "broken",
    "worker startup failed: constructor failed",
  ]);
  expect(sandbox.running()).toEqual(new Set(["peer"]));
  expect(peer.terminated).toBe(false);
  sandbox.stopAll();
});
