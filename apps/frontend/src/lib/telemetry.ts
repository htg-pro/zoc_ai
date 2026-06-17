/**
 * Local-only, opt-in telemetry. Events are forwarded to the Tauri shell
 * which writes them to `~/.llama-studio/logs/telemetry.log` *only if* the
 * user explicitly opted in via the onboarding wizard / settings panel.
 *
 * Nothing here ever talks to the network. When the shell is unavailable
 * (browser preview), calls are silently dropped.
 */
import { desktopConfigGet, telemetryLog } from "./tauri-bridge";

export type TelemetryKind =
  | "app.boot"
  | "onboarding.completed"
  | "session.created"
  | "session.deleted"
  | "session.message_sent"
  | "session.slash_command"
  | "patch.applied"
  | "patch.rejected"
  | "agent.run.applied"
  | "agent.run.discarded"
  | "agent.run.restored"
  | "inline_edit.queued"
  | "permission.grant"
  | "permission.grant_tool"
  | "permission.revoke_tool"
  | "permission.allowed"
  | "permission.denied"
  | "permission.resolve_approval"
  | "permission.retry_approval"
  | "permission.retried"
  | "terminal.spawned"
  | "indexer.rebuilt"
  | "review.completed"
  | "review.patch_queued"
  | "testgen.completed"
  | "testgen.saved"
  | "memory.compacted"
  | "memory.forgotten"
  | "error";

let optedIn: boolean | null = null;

async function consent(): Promise<boolean> {
  if (optedIn !== null) return optedIn;
  const cfg = await desktopConfigGet();
  optedIn = !!cfg.telemetry_opt_in;
  return optedIn;
}

export async function track(kind: TelemetryKind, meta: Record<string, unknown> = {}): Promise<void> {
  if (!(await consent())) return;
  try {
    await telemetryLog(kind, meta);
  } catch {
    /* swallow — telemetry must never break UX */
  }
}

/** Re-read the consent flag (call after the user changes settings). */
export function invalidateConsent(): void {
  optedIn = null;
}
