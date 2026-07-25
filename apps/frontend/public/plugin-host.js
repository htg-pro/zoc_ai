/*
 * Zoc plugin Web Worker host.
 *
 * This file is deliberately plain JavaScript because Vite serves it from
 * /plugin-host.js and the browser starts one dedicated worker per plugin.
 * Privileged operations are available only through the frozen `zoc` facade;
 * direct worker networking/control globals are removed before plugin code runs.
 */
(() => {
  "use strict";

  // Capture the host control plane before removing it from the plugin realm.
  const hostPostMessage = self.postMessage.bind(self);
  const hostAddEventListener = self.addEventListener.bind(self);
  const hostSetTimeout = self.setTimeout.bind(self);
  const hostClearTimeout = self.clearTimeout.bind(self);
  const HostFunction = Function;

  let pluginId = "";
  let loaded = false;
  let requestSeq = 0;
  const pending = new Map();
  const handlers = new Map();

  const messageOf = (error) => {
    const text = error instanceof Error ? error.message : String(error || "plugin error");
    return text.slice(0, 2_000);
  };

  const post = (message) => {
    try {
      hostPostMessage(message);
    } catch {
      // The owner may already have terminated this worker.
    }
  };

  const reportError = (error) => {
    post({ type: "error", pluginId, message: messageOf(error) });
  };

  hostAddEventListener("unhandledrejection", (event) => {
    event.preventDefault();
    reportError(event.reason || "unhandled plugin rejection");
  });
  hostAddEventListener("error", (event) => {
    reportError(event.error || event.message || "plugin worker error");
  });

  // Block direct I/O, worker creation, persistence, global messaging, timers,
  // eval, and Function construction. The host uses only the captured bindings.
  const blockedGlobals = [
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "importScripts",
    "indexedDB",
    "caches",
    "navigator",
    "location",
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
    "postMessage",
    "close",
    "onmessage",
    "onmessageerror",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "queueMicrotask",
    "eval",
    "Function",
  ];
  for (const name of blockedGlobals) {
    try {
      Object.defineProperty(self, name, {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      try {
        self[name] = undefined;
      } catch {
        // Some browser-owned properties are immutable; they are also shadowed
        // in the plugin function below where syntactically possible.
      }
    }
  }

  // Prevent the common `({}).constructor.constructor(...)` family of escapes.
  const constructorFunctions = [
    HostFunction,
    Object.getPrototypeOf(async function () {}).constructor,
    Object.getPrototypeOf(function* () {}).constructor,
    Object.getPrototypeOf(async function* () {}).constructor,
  ];
  for (const constructorFunction of constructorFunctions) {
    try {
      Object.defineProperty(constructorFunction.prototype, "constructor", {
        value: undefined,
        writable: false,
        configurable: false,
      });
    } catch {
      // Continue with the global lockdown if a browser freezes a prototype.
    }
  }

  const callHost = (api, method, args) =>
    new Promise((resolve, reject) => {
      requestSeq += 1;
      const reqId = requestSeq;
      const timer = hostSetTimeout(() => {
        pending.delete(reqId);
        reject(new Error(`Plugin API request timed out: ${api}.${method}`));
      }, 30_000);
      pending.set(reqId, { resolve, reject, timer });
      try {
        hostPostMessage({
          type: "api-request",
          pluginId,
          reqId,
          api,
          method,
          args,
        });
      } catch (error) {
        hostClearTimeout(timer);
        pending.delete(reqId);
        reject(error);
      }
    });

  const zoc = Object.freeze({
    editor: Object.freeze({
      getText: () => callHost("editor", "getText", []),
      setText: (text) => callHost("editor", "setText", [text]),
      getSelection: () => callHost("editor", "getSelection", []),
    }),
    terminal: Object.freeze({
      run: (command) => callHost("terminal", "run", [command]),
    }),
    storage: Object.freeze({
      get: (key) => callHost("storage", "get", [key]),
      set: (key, value) => callHost("storage", "set", [key, value]),
    }),
    ui: Object.freeze({
      showMessage: (message, level = "info") =>
        callHost("ui", "showMessage", [message, level]),
    }),
    commands: Object.freeze({
      register: (commandId, handler) => {
        if (
          typeof commandId !== "string" ||
          commandId.trim() === "" ||
          commandId.length > 256
        ) {
          throw new Error("Plugin command id must be a non-empty string of at most 256 characters.");
        }
        if (typeof handler !== "function") {
          throw new Error(`Plugin command handler must be a function: ${commandId}`);
        }
        if (handlers.has(commandId)) {
          throw new Error(`Plugin command is already registered: ${commandId}`);
        }
        handlers.set(commandId, handler);
        hostPostMessage({ type: "register-command", pluginId, commandId });
      },
    }),
  });

  const shadowNames = [
    "self",
    "globalThis",
    "fetch",
    "XMLHttpRequest",
    "WebSocket",
    "EventSource",
    "WebTransport",
    "RTCPeerConnection",
    "Worker",
    "SharedWorker",
    "BroadcastChannel",
    "importScripts",
    "indexedDB",
    "caches",
    "navigator",
    "location",
    "addEventListener",
    "removeEventListener",
    "dispatchEvent",
    "postMessage",
    "close",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    "clearInterval",
    "queueMicrotask",
    "Function",
  ];

  const hasDirectImport = (code) =>
    /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*(?:\n|$))*\(/.test(code) ||
    /(^|[;{}\n])\s*import\s+/.test(code);

  hostAddEventListener("message", async (event) => {
    const message = event.data || {};
    try {
      if (message.type === "load") {
        if (loaded) throw new Error("Plugin worker has already been loaded.");
        if (typeof message.pluginId !== "string" || message.pluginId.length === 0) {
          throw new Error("Invalid plugin identity.");
        }
        pluginId = message.pluginId;
        if (typeof message.code !== "string" || message.code.length > 2 * 1024 * 1024) {
          throw new Error("Plugin code is missing or exceeds the 2 MiB limit.");
        }
        if (hasDirectImport(message.code)) {
          throw new Error("Plugin code may not import external modules.");
        }
        loaded = true;
        const activate = HostFunction(
          "zoc",
          ...shadowNames,
          `"use strict";\n${message.code}\n//# sourceURL=zoc-plugin://${encodeURIComponent(pluginId)}/main.js`,
        );
        const result = activate(zoc, ...shadowNames.map(() => undefined));
        if (result && typeof result.then === "function") await result;
        post({ type: "ready", pluginId });
        return;
      }

      if (message.type === "api-response") {
        const entry = pending.get(message.reqId);
        if (!entry) return;
        pending.delete(message.reqId);
        hostClearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.value);
        else entry.reject(new Error(message.error || "Plugin API call failed."));
        return;
      }

      if (message.type === "invoke") {
        if (!Number.isSafeInteger(message.callId) || typeof message.commandId !== "string") {
          throw new Error("Invalid command invocation.");
        }
        const handler = handlers.get(message.commandId);
        if (!handler) {
          post({
            type: "invoke-result",
            callId: message.callId,
            ok: false,
            error: `No handler registered for ${message.commandId}`,
          });
          return;
        }
        try {
          await handler();
          post({ type: "invoke-result", callId: message.callId, ok: true });
        } catch (error) {
          post({
            type: "invoke-result",
            callId: message.callId,
            ok: false,
            error: messageOf(error),
          });
        }
      }
    } catch (error) {
      reportError(error);
    }
  });
})();
