/**
 * Privacy-first, opt-in telemetry (§11.2).
 *
 * Three rules define this module, and each is enforced in code rather than by
 * convention:
 *
 * 1. **Nothing without consent.** Every call funnels through {@link consent};
 *    with `telemetry_opt_in === false` no event is written and no request is
 *    made. The Rust `telemetry_log` command re-checks consent at the only write
 *    path, so even a bug here cannot produce a file on disk.
 * 2. **No PII, ever.** The payload types below are closed: each event carries
 *    only enums, booleans and numbers. There is no field that can hold a file
 *    path, a prompt, code, or a user identifier — the schema makes leaking one
 *    a type error rather than a review question.
 * 3. **Never blocks the UI.** Events are fire-and-forget; the batch upload has a
 *    5 s timeout and swallows every failure.
 *
 * Events are appended to `~/.zoc-studio/telemetry.jsonl` (rotated at 10 MB by
 * the Rust side). On app start, if the store has more than
 * {@link UPLOAD_THRESHOLD} events *and* the user opted in, the batch is POSTed
 * to {@link TELEMETRY_ENDPOINT} and cleared.
 */
import {
  desktopConfigGet,
  telemetryDrain,
  telemetryEvent,
  telemetryLog,
  telemetryStats,
} from "./tauri-bridge";

/**
 * Kinds accepted by the local-only diagnostic channel ({@link track}).
 *
 * These are breadcrumbs for the user's own log file, not analytics, which is why
 * they are allowed to carry workspace detail.
 */
export type LocalDiagnosticKind =
  | "app.boot"
  | "onboarding.completed"
  | "session.created"
  | "session.deleted"
  | "session.message_sent"
  | "session.renamed"
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

/** Remote collector. Only ever contacted for an opted-in, non-empty batch. */
export const TELEMETRY_ENDPOINT = "https://telemetry.zoc.studio/v1/events";

/** Minimum number of stored events before a batch upload is attempted. */
export const UPLOAD_THRESHOLD = 1000;

/** Hard timeout for the upload, so a hanging collector never stalls startup. */
export const UPLOAD_TIMEOUT_MS = 5000;

export type ModelKind = "local" | "cloud";
export type RunMode = "ask" | "plan" | "agent";

/**
 * The complete telemetry schema (§11.2).
 *
 * Every payload is deliberately made of low-cardinality, non-identifying
 * values. Note what is absent: no `path`, no `prompt`, no `content`, no
 * `workspace`, no user or machine id.
 */
export interface TelemetryEvents {
  app_start: { os: string; arch: string; model_kind: ModelKind };
  run_completed: {
    mode: RunMode;
    stage_reached: string;
    token_count: number;
    input_tokens: number;
    output_tokens: number;
    estimated_cost_cents: number;
    context_window_proportion: number;
    duration_ms: number;
    succeeded: boolean;
    recovery_count: number;
  };
  run_cancelled: { stage_at_cancel: string };
  inline_edit_used: { language: string; accepted: boolean };
  lsp_connected: { language: string };
  plugin_installed: Record<string, never>;
  crash: { exit_code: number | null };
}

export type TelemetryKind = keyof TelemetryEvents;

const FORBIDDEN_TELEMETRY_KEY = /(prompt|content|file|credential|secret|api[_-]?key|token_value)/iu;

/** Runtime backstop for callers crossing a JS boundary with an untyped cast. */
export function isTelemetrySafePayload(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (Array.isArray(value)) return value.every(isTelemetrySafePayload);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_TELEMETRY_KEY.test(key)) return false;
    if (!isTelemetrySafePayload(child)) return false;
  }
  return true;
}

let optedIn: boolean | null = null;

async function consent(): Promise<boolean> {
  if (optedIn !== null) return optedIn;
  const cfg = await desktopConfigGet();
  optedIn = !!cfg.telemetry_opt_in;
  return optedIn;
}

/**
 * Local diagnostic breadcrumbs (legacy channel).
 *
 * These payloads may reference tool names, workspace paths and other local
 * detail, so they are written to `~/.zoc-studio/logs/telemetry.log` and are
 * **never** uploaded. Use {@link trackEvent} for anything that may leave the
 * machine.
 */
export async function track(
  kind: LocalDiagnosticKind,
  meta: Record<string, unknown> = {},
): Promise<void> {
  if (!(await consent())) return;
  try {
    await telemetryLog(kind, meta);
  } catch {
    /* swallow — telemetry must never break UX */
  }
}

/**
 * Record one anonymous usage event (§11.2).
 *
 * Written to `telemetry.jsonl`, the only store eligible for batch upload. The
 * generic signature ties `payload` to `kind` through {@link TelemetryEvents}, so
 * adding an identifying field to a call site is a compile error.
 */
export async function trackEvent<K extends TelemetryKind>(
  kind: K,
  payload: TelemetryEvents[K],
): Promise<void> {
  if (!(await consent())) return;
  if (!isTelemetrySafePayload(payload)) return;
  try {
    await telemetryEvent(kind, payload as Record<string, unknown>);
  } catch {
    /* swallow — telemetry must never break UX */
  }
}

/** Re-read the consent flag (call after the user changes settings). */
export function invalidateConsent(): void {
  optedIn = null;
}

/** Test seam: force the cached consent value. */
export function __setConsentForTests(value: boolean | null): void {
  optedIn = value;
}

/** Normalised OS/arch labels for `app_start`, derived from the user agent. */
export function platformLabels(userAgent: string): { os: string; arch: string } {
  const ua = userAgent.toLowerCase();
  const os = ua.includes("win")
    ? "windows"
    : ua.includes("mac")
      ? "macos"
      : ua.includes("linux")
        ? "linux"
        : "unknown";
  const arch =
    ua.includes("arm64") || ua.includes("aarch64")
      ? "arm64"
      : ua.includes("x86_64") || ua.includes("win64") || ua.includes("x64")
        ? "x86_64"
        : "unknown";
  return { os, arch };
}

/**
 * Whether a batch upload should be attempted.
 *
 * Split out as a pure predicate so the "opted in **and** over threshold" rule is
 * directly testable — this is the gate that decides whether anything leaves the
 * machine.
 */
export function shouldUpload(stats: { opted_in: boolean; events: number }): boolean {
  return stats.opted_in && stats.events > UPLOAD_THRESHOLD;
}

/**
 * Upload the pending batch if one is due, then clear it.
 *
 * Fire-and-forget by design: callers do not await the network. Returns the
 * number of events sent (0 when nothing was due or the upload failed), which
 * makes the behaviour observable in tests without exposing the request.
 */
export async function flushTelemetry(): Promise<number> {
  try {
    const stats = await telemetryStats();
    if (!shouldUpload(stats)) return 0;

    const events = await telemetryDrain();
    if (events.length === 0) return 0;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      await fetch(TELEMETRY_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
      return events.length;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // Offline, blocked, aborted, or no shell — all equally fine.
    return 0;
  }
}

/**
 * Record `app_start` and opportunistically flush. Safe to call unconditionally
 * from app bootstrap: it returns immediately when telemetry is disabled.
 */
export async function startTelemetry(modelKind: ModelKind): Promise<void> {
  if (!(await consent())) return;
  const { os, arch } = platformLabels(typeof navigator === "undefined" ? "" : navigator.userAgent);
  void trackEvent("app_start", { os, arch, model_kind: modelKind });
  void flushTelemetry();
}
