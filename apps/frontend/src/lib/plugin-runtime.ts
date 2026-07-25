/**
 * Plugin runtime wiring (Part 5.1, task 4.1). Connects the plugin lifecycle
 * (`plugins.ts`) to the execution sandbox (`plugins-sandbox.ts`): loads a
 * worker for every enabled plugin that carries contribution code, stops
 * workers for disabled/removed plugins, and routes contributed-command
 * invocation into the owning worker. `createDefaultPluginSandbox` builds the
 * sandbox with real host dependencies (permission-gated terminal, editor,
 * storage, ui).
 */
import { getActiveSelection, getActiveText, setActiveText } from "./editor-actions";
import { getAgentClient, type AgentClient } from "./agent-client";
import { useApp } from "./store";
import type { Decision } from "./permissions-engine";
import {
  createPluginSandbox,
  type PluginSandbox,
  type SandboxDeps,
  type SandboxWorker,
} from "./plugins-sandbox";
import {
  clearPluginCommandRegistrations,
  getPlugins,
  registerPluginCommand,
  reportPluginError,
  setPluginCommandInvoker,
  subscribePlugins,
} from "./plugins";
import { checkAction } from "./trust";

export interface ReconcilePlan {
  load: Array<[string, string]>;
  stop: string[];
}

/** Pure: given the running workers and the desired (enabled+coded) set, the
 *  plugins to load (id+code) and to stop. */
export function reconcilePlugins(
  running: ReadonlySet<string>,
  desired: ReadonlyMap<string, string>,
  runningCode?: ReadonlyMap<string, string>,
  desiredRevision?: ReadonlyMap<string, string>,
): ReconcilePlan {
  const load: Array<[string, string]> = [];
  const stop: string[] = [];
  for (const [id, code] of desired) {
    const targetRevision = desiredRevision?.get(id) ?? code;
    if (!running.has(id)) {
      load.push([id, code]);
    } else if (runningCode && runningCode.get(id) !== targetRevision) {
      stop.push(id);
      load.push([id, code]);
    }
  }
  for (const id of running) {
    if (!desired.has(id)) stop.push(id);
  }
  return { load, stop };
}

/** The plugins that should have a live worker: enabled, not errored, with code. */
export function desiredPluginWorkers(): Map<string, string> {
  const desired = new Map<string, string>();
  for (const plugin of getPlugins()) {
    if (plugin.enabled && !plugin.errored && plugin.code) {
      desired.set(plugin.manifest.id, plugin.code);
    }
  }
  return desired;
}

function desiredPluginWorkerRevisions(): Map<string, string> {
  const desired = new Map<string, string>();
  for (const plugin of getPlugins()) {
    if (plugin.enabled && !plugin.errored && plugin.code) {
      desired.set(plugin.manifest.id, String(plugin.revision));
    }
  }
  return desired;
}

/**
 * Wire the sandbox to the plugin lifecycle. Returns a disposer that detaches
 * the subscription, clears the command invoker, and stops every worker.
 */
export function initPluginRuntime(sandbox: PluginSandbox): () => void {
  const runningCode = new Map<string, string>();
  const reconcile = (): void => {
    const desired = desiredPluginWorkers();
    const desiredRevisions = desiredPluginWorkerRevisions();
    const { load, stop } = reconcilePlugins(
      sandbox.running(),
      desired,
      runningCode,
      desiredRevisions,
    );
    for (const id of stop) {
      clearPluginCommandRegistrations(id);
      sandbox.stop(id);
      runningCode.delete(id);
    }
    for (const [id, code] of load) {
      runningCode.set(id, desiredRevisions.get(id) ?? code);
      sandbox.load(id, code);
      if (!sandbox.running().has(id)) runningCode.delete(id);
    }
  };
  setPluginCommandInvoker((pluginId, commandId) => sandbox.invokeCommand(pluginId, commandId));
  reconcile();
  const unsubscribe = subscribePlugins(reconcile);
  return () => {
    unsubscribe();
    setPluginCommandInvoker(null);
    for (const id of sandbox.running()) clearPluginCommandRegistrations(id);
    sandbox.stopAll();
    runningCode.clear();
  };
}

export interface PluginTerminalRunOptions {
  client?: Pick<AgentClient, "spawnTerminal" | "stopTerminal" | "terminalStream">;
  platform?: "unix" | "windows";
  cwd?: string | null;
  timeoutMs?: number;
  maxOutputChars?: number;
}

/** Execute one plugin command through the confined gateway terminal API. */
export async function runPluginTerminalCommand(
  command: string,
  options: PluginTerminalRunOptions = {},
): Promise<string> {
  if (command.trim() === "" || command.length > 32_768) {
    throw new Error("Plugin terminal command must contain 1–32768 characters.");
  }
  const client = options.client ?? (await getAgentClient());
  const platform =
    options.platform ??
    (typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent)
      ? "windows"
      : "unix");
  const executable = platform === "windows" ? "cmd.exe" : "/bin/sh";
  const args =
    platform === "windows" ? ["/d", "/s", "/c", command] : ["-lc", command];
  const cwd = options.cwd ?? useApp.getState().workspaceRoot ?? undefined;
  const session = await client.spawnTerminal(executable, {
    args,
    ...(cwd ? { cwd } : {}),
    cols: 120,
    rows: 30,
  });
  const abort = new AbortController();
  const timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
  const maxOutput = Math.max(128, options.maxOutputChars ?? 64 * 1024);
  const truncatedMarker = "\n[plugin output truncated]";
  let output = "";
  let truncated = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort.abort();
    void client.stopTerminal(session.id).catch(() => undefined);
  }, timeoutMs);

  try {
    for await (const event of client.terminalStream(session.id, abort.signal)) {
      if (event.type === "data" && !truncated) {
        const combined = output + event.chunk;
        if (combined.length > maxOutput) {
          output =
            combined.slice(0, Math.max(0, maxOutput - truncatedMarker.length)) +
            truncatedMarker;
          truncated = true;
        } else {
          output = combined;
        }
      } else if (event.type === "error") {
        throw new Error(event.message);
      } else if (event.type === "exit") {
        break;
      }
    }
  } catch (error) {
    if (!timedOut) throw error;
  } finally {
    clearTimeout(timer);
    abort.abort();
    await client.stopTerminal(session.id).catch(() => undefined);
  }
  if (timedOut) throw new Error(`Plugin terminal command timed out after ${timeoutMs} ms.`);
  return output;
}

function pluginStoragePart(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

function pluginStorageKey(pluginId: string, key: string): string {
  if (!pluginId || key.length === 0 || key.length > 256) {
    throw new Error("Plugin storage keys must contain 1–256 characters.");
  }
  return `zoc.plugin.kv.${pluginStoragePart(pluginId)}.${pluginStoragePart(key)}`;
}

/**
 * Build a sandbox with real worker, gateway-terminal, editor, namespaced
 * storage, command-registration, and failure-isolation dependencies.
 */
export function createDefaultPluginSandbox(
  runTerminal?: (command: string) => Promise<string>,
): PluginSandbox {
  const deps: SandboxDeps = {
    workerFactory: () =>
      new Worker("/plugin-host.js", { type: "module" }) as unknown as SandboxWorker,
    checkTerminalPermission: (command: string): Decision =>
      checkAction({ kind: "terminal", name: command }),
    runTerminal: runTerminal ?? runPluginTerminalCommand,
    editor: {
      getText: () => getActiveText(),
      setText: (text: string) => setActiveText(text),
      getSelection: () => getActiveSelection() ?? "",
    },
    storage: {
      get: (pluginId: string, key: string) => {
        const raw = localStorage.getItem(pluginStorageKey(pluginId, key));
        if (raw == null) return undefined;
        if (raw.length > 64 * 1024) throw new Error("Stored plugin value exceeds 64 KiB.");
        return JSON.parse(raw) as unknown;
      },
      set: (pluginId: string, key: string, value: unknown) => {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) throw new Error("Plugin storage value is not serializable.");
        if (serialized.length > 64 * 1024) throw new Error("Plugin storage value exceeds 64 KiB.");
        localStorage.setItem(pluginStorageKey(pluginId, key), serialized);
      },
    },
    ui: {
      showMessage: (message: string, level: string) => {
        console.info(`[plugin:${level}] ${message}`);
      },
    },
    onRegisterCommand: (pluginId: string, commandId: string) => {
      if (!registerPluginCommand(pluginId, commandId)) {
        throw new Error(`Plugin attempted to register undeclared command: ${commandId}`);
      }
    },
    onStop: (pluginId: string) => clearPluginCommandRegistrations(pluginId),
    onError: (pluginId: string, message: string) => reportPluginError(pluginId, message),
  };
  return createPluginSandbox(deps);
}
