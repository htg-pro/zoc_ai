/**
 * diagnostics.ts — a bounded ring buffer for the things the render pipeline
 * drops, surfaced in the Logs panel (R9.2, R10.2).
 *
 * Two events are recorded here and nowhere else:
 *   - a normalizer discard (unknown type, malformed, cross-run, …),
 *   - a feed row whose `kind` has no registered renderer.
 *
 * Both are silent to the user by design; recording them is what turns "an
 * unmapped event is indistinguishable from a bug" into an inspectable fact.
 */

export type DiagnosticKind = "discard" | "unrenderable-kind";

export interface DiagnosticEntry {
  kind: DiagnosticKind;
  /** For a discard: the discard reason. For an unrenderable row: the row kind. */
  reason: string;
  /** The unrecognized event `type` or row `kind`, when known. */
  detail: string | null;
  at: number;
}

const MAX_ENTRIES = 200;

let buffer: DiagnosticEntry[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function push(entry: DiagnosticEntry): void {
  buffer = [...buffer.slice(-(MAX_ENTRIES - 1)), entry];
  emit();
}

/** Record a normalizer discard (R9.2). */
export function recordDiscard(reason: string, rawType: string | null): void {
  push({ kind: "discard", reason, detail: rawType, at: Date.now() });
}

/** Record a feed row whose `kind` has no registered renderer (R10.2). */
export function recordUnrenderableKind(kind: string): void {
  push({ kind: "unrenderable-kind", reason: "no-renderer", detail: kind, at: Date.now() });
}

/** A stable snapshot of the diagnostics buffer for `useSyncExternalStore`. */
export function getDiagnosticsSnapshot(): readonly DiagnosticEntry[] {
  return buffer;
}

export function subscribeDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test hook: clear the buffer. */
export function clearDiagnostics(): void {
  buffer = [];
  emit();
}
