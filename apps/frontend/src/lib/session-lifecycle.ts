/**
 * Session lifecycle resolver (R2.1-R2.5).
 *
 * `resolveSessionIntent` maps a lifecycle trigger to a `SessionIntent`,
 * making session connection deterministic and removing the unconditional
 * "always select sessions[0]" auto-resume. Everything here is a pure,
 * deterministic function of its inputs — no I/O, no clock, no globals — so it
 * can be exercised directly with generated session lists and triggers.
 */
import type { Session } from "@llama-studio/shared-types";

/** The lifecycle event that drives session connection. */
export type LifecycleTrigger = "app-open" | "new-chat" | "select" | "delete-active";

/**
 * How a session connection should resolve:
 * - `fresh`: start a clean session, never resume a prior one.
 * - `resume`: resume an explicit prior session (only on `app-open`).
 * - `select`: the user explicitly chose an existing session.
 */
export type SessionIntent =
  | { kind: "fresh" }
  | { kind: "resume"; sessionId: string }
  | { kind: "select"; sessionId: string };

export interface LifecycleInput {
  trigger: LifecycleTrigger;
  sessions: Session[];
  /** Persisted, explicit "last active" pointer; honored only if it exists. */
  lastActiveId: string | null;
  /** The requested id for `select`/`delete-active` triggers. */
  selectedId?: string | null;
}

/**
 * Resolve a lifecycle trigger to a `SessionIntent` (R2.1-R2.5).
 *
 * - `new-chat` always yields `fresh`, regardless of the session list or
 *   `lastActiveId` (R2.1).
 * - `app-open` yields `resume` only when `lastActiveId` names an existing
 *   session, otherwise `fresh` (R2.2).
 * - `select` yields `select` when `selectedId` names an existing session,
 *   otherwise `fresh` (R2.3, R2.4).
 * - `delete-active` always yields `fresh` (R2.5).
 */
export function resolveSessionIntent(input: LifecycleInput): SessionIntent {
  const exists = (id: string | null | undefined): boolean =>
    id != null && input.sessions.some((s) => s.id === id);

  switch (input.trigger) {
    case "new-chat":
      return { kind: "fresh" };
    case "select":
      return exists(input.selectedId)
        ? { kind: "select", sessionId: input.selectedId! }
        : { kind: "fresh" };
    case "delete-active":
      return { kind: "fresh" };
    case "app-open":
      return exists(input.lastActiveId)
        ? { kind: "resume", sessionId: input.lastActiveId! }
        : { kind: "fresh" };
  }
}
