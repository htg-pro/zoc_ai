import type { WorkspaceIndexProgress } from "@zoc-studio/shared-types";
import { resolveAgentPort } from "./agent-port";

const INITIAL_RECONNECT_MS = 500;
const MAX_RECONNECT_MS = 5_000;

export interface IndexProgressSocket {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

type SocketFactory = (url: string) => IndexProgressSocket;

export function workspaceIndexProgressUrl(port: number): string {
  return `ws://127.0.0.1:${port}/v1/workspace/index-progress`;
}

export async function subscribeWorkspaceIndexProgress(
  onProgress: (progress: WorkspaceIndexProgress) => void,
  socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as IndexProgressSocket,
): Promise<() => void> {
  const port = await resolveAgentPort();
  const url = workspaceIndexProgressUrl(port);
  let socket: IndexProgressSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_MS;
  let disposed = false;

  const connect = () => {
    if (disposed) return;
    socket = socketFactory(url);
    socket.onopen = () => {
      reconnectDelay = INITIAL_RECONNECT_MS;
    };
    socket.onmessage = (event) => {
      const parsed = parseIndexProgress(event.data);
      if (parsed) onProgress(parsed);
    };
    socket.onerror = () => {
      socket?.close();
    };
    socket.onclose = () => {
      socket = null;
      if (disposed) return;
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(MAX_RECONNECT_MS, reconnectDelay * 2);
    };
  };

  connect();
  return () => {
    disposed = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
  };
}

export function parseIndexProgress(payload: string): WorkspaceIndexProgress | null {
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const type = value.type;
  if (
    type !== "index.started" &&
    type !== "index.progress" &&
    type !== "index.completed" &&
    type !== "index.error"
  ) {
    return null;
  }
  if (
    typeof value.sessionId !== "string" ||
    !isNonnegativeNumber(value.processedFiles) ||
    !isNonnegativeNumber(value.totalFiles) ||
    !isNonnegativeNumber(value.indexedFiles) ||
    !isNonnegativeNumber(value.tokenCount)
  ) {
    return null;
  }
  return value as unknown as WorkspaceIndexProgress;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonnegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
