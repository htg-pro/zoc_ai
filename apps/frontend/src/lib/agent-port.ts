import { agentPort, agentStatus, isTauri } from "./tauri-bridge";

export const PORT_WAIT_MS = 30_000;
export const HEALTH_WAIT_MS = 30_000;
export const PORT_POLL_MS = 250;
export const DEFAULT_DEV_PORT = 8765;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_WAIT_MS;
  let lastError: string | null = null;
  const url = `http://127.0.0.1:${port}/health`;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = `http ${res.status}`;
    } catch (err) {
      lastError = (err as Error).message;
    }
    await delay(PORT_POLL_MS);
  }

  throw new Error(`Agent sidecar port ${port} did not pass /health: ${lastError ?? "timed out"}`);
}

async function waitForDesktopAgentPort(): Promise<number> {
  const deadline = Date.now() + PORT_WAIT_MS;
  let lastError: string | null = null;

  while (Date.now() < deadline) {
    const status = await agentStatus();
    if (typeof status?.port === "number" && status.port > 0) {
      await waitForHealth(status.port);
      return status.port;
    }
    if (status?.last_error) lastError = status.last_error;

    const port = await agentPort();
    if (typeof port === "number" && port > 0) {
      await waitForHealth(port);
      return port;
    }

    await delay(PORT_POLL_MS);
  }

  throw new Error(
    lastError
      ? `Agent sidecar did not become ready: ${lastError}`
      : "Agent sidecar did not become ready before the startup timeout.",
  );
}

export async function resolveAgentPort(): Promise<number> {
  const port = await agentPort();
  if (typeof port === "number" && port > 0) {
    if (isTauri()) await waitForHealth(port);
    return port;
  }
  if (isTauri()) return waitForDesktopAgentPort();
  const env = (import.meta as { env?: Record<string, string | undefined> }).env;
  const fallback = env?.VITE_AGENT_PORT;
  return fallback ? Number.parseInt(fallback, 10) : DEFAULT_DEV_PORT;
}
