/**
 * One `MonacoLanguageClient` per Server_Name (design.md "lsp/lsp-client.ts").
 *
 * A thin, singleton-guarded adapter over `monaco-languageclient` and
 * `vscode-ws-jsonrpc`. It holds a `Map<ServerName, ManagedClient>` so there is
 * at most one client per server (R3.5). `start` opens an `LSP_Connection`; on
 * each successful open it (re)builds the JSON-RPC transports from the live
 * socket, creates a `MonacoLanguageClient`, and starts it (which sends
 * `initialize`, R3.3). On close it stops+disposes the client so a fresh one is
 * built on reconnect. `stop` disposes both the client and the connection
 * (R3.4, R2.4) and removes the status entry (R5.6).
 *
 * The real `monaco-languageclient` / `vscode-ws-jsonrpc` are loaded through a
 * dynamic import inside the default factory so this module is import-safe in
 * the unit-test environment (tests inject `createLanguageClient` + a fake
 * `socketFactory` and never touch the heavy vscode stack). Providers register
 * only on a successful `onOpen`, which is what gates F12/Shift+F12/F2/hover on
 * a connected server (R4.5/R4.6, Property 8).
 */
import { openLspConnection } from "./lsp-connection";
import type {
  LanguageServerState,
  LspConnection,
  LspSocket,
  LspSocketFactory,
} from "./lsp-connection";
import type { LspDiagnostic } from "./diagnostics-bridge";
import type { ServerName } from "./lsp-registry";

/**
 * Language ids each server serves, used as the client's `documentSelector` so
 * Monaco registers definition/reference/rename/hover providers for them.
 */
const SERVER_LANGUAGES: Readonly<Record<ServerName, string[]>> = {
  "typescript-language-server": [
    "typescript",
    "typescriptreact",
    "javascript",
    "javascriptreact",
  ],
  pyright: ["python"],
  "rust-analyzer": ["rust"],
};

/**
 * The minimal language-client surface the adapter drives. A real
 * `MonacoLanguageClient` satisfies it structurally; keeping it minimal frees
 * the unit tests from the heavy `monaco-languageclient` type.
 */
export interface ManagedLanguageClient {
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  dispose?(): unknown;
}

/** Seam: build a language client for a server over a live socket. */
export type CreateLanguageClient = (args: {
  server: ServerName;
  socket: LspSocket;
}) => ManagedLanguageClient | Promise<ManagedLanguageClient>;

interface ManagedClient {
  connection: LspConnection | null;
  languageClient: ManagedLanguageClient | null;
  state: LanguageServerState;
}

export interface LspClient {
  start(server: ServerName): void;
  stop(server: ServerName): void;
  runningServers(): ReadonlySet<ServerName>;
}

export interface LspClientDeps {
  /** Idempotent one-time init of the monaco-languageclient service layer. */
  ensureServicesInitialized: () => Promise<void> | void;
  /** Reports state to the status slice (drives the indicator). */
  onServerState: (server: ServerName, state: LanguageServerState) => void;
  /** Removes the server's status entry when it shuts down (R5.6). */
  onServerRemoved: (server: ServerName) => void;
  /** Injected in tests; forwarded to the connection. */
  socketFactory?: LspSocketFactory;
  /** Injected in tests; defaults to the real MonacoLanguageClient builder. */
  createLanguageClient?: CreateLanguageClient;
  /**
   * Net-new (§3.2, R1): forward each `publishDiagnostics` notification to the
   * LSP_Diagnostics_Bridge. Wired as `middleware.handleDiagnostics` on the
   * language client so it runs after the client parses the wire payload into a
   * typed `Diagnostic[]` and a `Uri`, without disturbing the native squiggles.
   */
  onPublishDiagnostics?: (
    server: ServerName,
    uri: string,
    diags: readonly LspDiagnostic[],
  ) => void;
}

async function defaultCreateLanguageClient(args: {
  server: ServerName;
  socket: LspSocket;
  onPublishDiagnostics?: (
    server: ServerName,
    uri: string,
    diags: readonly LspDiagnostic[],
  ) => void;
}): Promise<ManagedLanguageClient> {
  const { server, socket, onPublishDiagnostics } = args;
  const { MonacoLanguageClient } = await import("monaco-languageclient");
  const { toSocket, WebSocketMessageReader, WebSocketMessageWriter } = await import(
    "vscode-ws-jsonrpc"
  );
  const rpc = toSocket(socket as unknown as WebSocket);
  const reader = new WebSocketMessageReader(rpc);
  const writer = new WebSocketMessageWriter(rpc);
  return new MonacoLanguageClient({
    name: server,
    clientOptions: {
      documentSelector: SERVER_LANGUAGES[server],
      // §3.2 R1: intercept parsed diagnostics, then preserve native squiggles.
      // vscode's `Diagnostic` shape differs from our minimal `LspDiagnostic`, so
      // bridge at this boundary; the forwarding is unit-tested directly via
      // `createDiagnosticsMiddleware`.
      middleware: createDiagnosticsMiddleware(server, onPublishDiagnostics) as unknown as never,
    },
    messageTransports: { reader, writer },
  });
}

/** The minimal middleware surface `vscode-languageclient` calls for diagnostics. */
interface DiagnosticsMiddleware {
  handleDiagnostics(
    uri: { toString(): string },
    diagnostics: readonly LspDiagnostic[],
    next: (uri: { toString(): string }, diagnostics: readonly LspDiagnostic[]) => void,
  ): void;
}

/**
 * Build the `handleDiagnostics` middleware (§3.2, R1). Extracted as a pure
 * factory so it is unit-testable without the heavy `monaco-languageclient`
 * stack: it forwards each publish to `onPublishDiagnostics` (with the URI
 * stringified) inside a `try`, and ALWAYS calls `next(uri, diagnostics)` in a
 * `finally` so native LSP squiggles render even if the bridge hook throws.
 */
export function createDiagnosticsMiddleware(
  server: ServerName,
  onPublishDiagnostics?: (
    server: ServerName,
    uri: string,
    diags: readonly LspDiagnostic[],
  ) => void,
): DiagnosticsMiddleware {
  return {
    handleDiagnostics(uri, diagnostics, next) {
      try {
        onPublishDiagnostics?.(server, uri.toString(), diagnostics);
      } finally {
        next(uri, diagnostics);
      }
    },
  };
}

export function createLspClient(deps: LspClientDeps): LspClient {
  const clients = new Map<ServerName, ManagedClient>();
  const buildLanguageClient: CreateLanguageClient =
    deps.createLanguageClient ??
    ((args) =>
      defaultCreateLanguageClient({
        ...args,
        onPublishDiagnostics: deps.onPublishDiagnostics,
      }));

  const disposeClient = (lc: ManagedLanguageClient | null): void => {
    if (!lc) return;
    // R3.4: stop, then dispose once the stop settles (success or failure).
    void Promise.resolve(lc.stop())
      .catch(() => undefined)
      .finally(() => {
        lc.dispose?.();
      });
  };

  return {
    start(server) {
      if (clients.has(server)) return; // R3.5 singleton / R2.3 reuse
      const managed: ManagedClient = {
        connection: null,
        languageClient: null,
        state: "starting",
      };
      clients.set(server, managed);
      void Promise.resolve(deps.ensureServicesInitialized())
        .then(async () => {
          if (clients.get(server) !== managed) return; // stopped during init
          const connection = await openLspConnection(server, {
            socketFactory: deps.socketFactory,
            onState: (state) => {
              managed.state = state;
              deps.onServerState(server, state);
            },
            onOpen: (socket) => {
              void Promise.resolve(buildLanguageClient({ server, socket }))
                .then((lc) => {
                  if (clients.get(server) !== managed) {
                    disposeClient(lc); // stopped mid-build → tear it back down
                    return;
                  }
                  managed.languageClient = lc;
                  return Promise.resolve(lc.start()).catch((err) => {
                    console.warn(`monaco-lsp: "${server}" client failed to start`, err);
                  });
                })
                .catch((err) => {
                  console.warn(`monaco-lsp: "${server}" client build failed`, err);
                });
            },
            onClose: () => {
              // Drop the client so a reconnect rebuilds it on the next onOpen.
              const lc = managed.languageClient;
              managed.languageClient = null;
              disposeClient(lc);
            },
          });
          if (clients.get(server) !== managed) {
            connection.dispose(); // stopped while awaiting the connection
            return;
          }
          managed.connection = connection;
        })
        .catch((err) => {
          if (clients.get(server) !== managed) return;
          managed.state = "error";
          deps.onServerState(server, "error");
          console.warn(`monaco-lsp: "${server}" failed to start`, err);
        });
    },
    stop(server) {
      const managed = clients.get(server);
      if (!managed) return;
      clients.delete(server);
      const lc = managed.languageClient;
      managed.languageClient = null;
      disposeClient(lc); // R3.4
      managed.connection?.dispose(); // R1.4 / R2.4
      deps.onServerRemoved(server); // R5.6
    },
    runningServers() {
      return new Set(clients.keys());
    },
  };
}
