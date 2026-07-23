/**
 * LSP WebSocket transport with reconnect/backoff (monaco-lsp-integration).
 *
 * Mirrors the reconnect/backoff shape of `src/lib/index-progress.ts`: an
 * injected socket factory, an authoritative `disposed` flag, and a
 * `500ms → 5000ms` exponential backoff. The one addition is that `onclose`
 * receives the WebSocket close code so the connection can distinguish the two
 * application close codes the Gateway may send, and it reports a
 * `LanguageServerState` through an `onState` callback that drives the
 * per-language status indicator.
 */
import { resolveAgentPort } from "@/lib/agent-port";

// Application close codes the Gateway may send (kept in sync with the
// `services/gateway/src/zocai_gateway/routes/lsp.py` mirror constants).
export const ABNORMAL_SERVER_TERMINATION_CLOSE_CODE = 4050;
export const SERVER_NOT_INSTALLED_CLOSE_CODE = 4041;

export const INITIAL_RECONNECT_MS = 500;
export const MAX_RECONNECT_MS = 5_000;

export type LanguageServerState = "starting" | "connected" | "error";

/**
 * Minimal socket surface (a real `WebSocket` satisfies it). `onclose` receives
 * the close code so the two Application_Close_Codes can be told apart; the
 * browser `CloseEvent.code` provides it.
 */
export interface LspSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export type LspSocketFactory = (url: string) => LspSocket;

export interface LspConnectionOptions {
  /**
   * Called on each successful open with the live socket, so the LSP_Client can
   * build its vscode-ws-jsonrpc reader/writer and start a client.
   */
  onOpen: (socket: LspSocket) => void;
  /** Called when an established socket closes (any reason). */
  onClose: () => void;
  /** Called on every Language_Server_State transition (drives the indicator). */
  onState: (state: LanguageServerState) => void;
  /** Injected for tests; defaults to the real WebSocket. */
  socketFactory?: LspSocketFactory;
}

export interface LspConnection {
  /** Idempotent teardown: cancels any pending reconnect and closes the socket. */
  dispose(): void;
}

export function lspConnectionUrl(port: number, serverName: string): string {
  return `ws://127.0.0.1:${port}/v1/lsp/${serverName}/ws`;
}

export async function openLspConnection(
  serverName: string,
  options: LspConnectionOptions,
): Promise<LspConnection> {
  const factory =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as LspSocket);
  const port = await resolveAgentPort();
  const url = lspConnectionUrl(port, serverName);

  let socket: LspSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_MS;
  let disposed = false; // caller teardown — authoritative
  let stopped = false; // server-not-installed: terminal, but not a dispose

  const setState = (state: LanguageServerState) => options.onState(state);

  const connect = () => {
    if (disposed || stopped) return;
    setState("starting");
    socket = factory(url);
    socket.onopen = () => {
      reconnectDelay = INITIAL_RECONNECT_MS;
      setState("connected");
      if (socket) options.onOpen(socket);
    };
    socket.onerror = () => socket?.close();
    socket.onclose = (event) => {
      socket = null;
      options.onClose();
      if (disposed) return;
      if (event.code === SERVER_NOT_INSTALLED_CLOSE_CODE) {
        stopped = true; // stop reconnecting
        setState("error");
        return;
      }
      // Abnormal termination or any transient drop → backoff reconnect.
      setState("starting");
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
    };
  };

  connect();

  return {
    dispose() {
      disposed = true;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close();
      socket = null;
    },
  };
}
