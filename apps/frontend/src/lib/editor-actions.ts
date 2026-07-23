/**
 * Bridge between the command registry and the live Monaco editor (Phase 9).
 *
 * `MonacoView` registers the focused editor here on mount; commands like Format
 * Document / Go to Line / Go to Symbol then trigger Monaco's built-in actions,
 * and other surfaces (breadcrumbs, outline) can reveal a line. Kept out of the
 * store because a Monaco editor instance isn't serializable.
 */

interface ActiveEditor {
  // Loosely typed — we only touch a tiny, stable slice of the Monaco API.
  getAction?: (id: string) => { run: () => void } | null;
  getModel?: () => { getValueInRange?: (selection: unknown) => string } | null;
  getSelection?: () => unknown | null;
  revealLineInCenter?: (line: number) => void;
  setPosition?: (pos: { lineNumber: number; column: number }) => void;
  focus?: () => void;
}

let active: ActiveEditor | null = null;

export function setActiveEditor(editor: ActiveEditor | null): void {
  active = editor;
}

export function clearActiveEditor(editor: ActiveEditor): void {
  if (active === editor) active = null;
}

export function hasActiveEditor(): boolean {
  return active !== null;
}

/** Return the focused editor's non-empty selection for Composer commands. */
export function getActiveSelection(): string | null {
  const model = active?.getModel?.();
  const selection = active?.getSelection?.();
  if (!model?.getValueInRange || !selection) return null;
  const text = model.getValueInRange(selection);
  return text.trim() ? text : null;
}

/** Run a built-in Monaco editor action by id. Returns false when no editor is
 *  focused. */
export function runEditorAction(id: string): boolean {
  const a = active;
  if (!a?.getAction) return false;
  const action = a.getAction(id);
  if (!action) return false;
  action.run();
  return true;
}

export function formatDocument(): boolean {
  return runEditorAction("editor.action.formatDocument");
}

export function goToLine(): boolean {
  return runEditorAction("editor.action.gotoLine");
}

export function goToSymbolInFile(): boolean {
  return runEditorAction("editor.action.quickOutline");
}

/** Move the caret to a line and reveal it (used by breadcrumbs / outline). */
export function revealLine(line: number): void {
  active?.revealLineInCenter?.(line);
  active?.setPosition?.({ lineNumber: line, column: 1 });
  active?.focus?.();
}

/**
 * R3.2/R3.3: scroll `line` into view and place the caret at (`line`, `column`),
 * both 1-based. Used by the Problems panel to jump to the exact diagnostic
 * position in the already-active editor.
 */
export function revealPosition(line: number, column: number): void {
  active?.revealLineInCenter?.(line);
  active?.setPosition?.({ lineNumber: line, column });
  active?.focus?.();
}

// ── Pending reveal buffer (R3.2/R3.3 for a freshly-opened file) ─────────────
// When a Problems-panel click opens a not-yet-mounted file, the active editor
// is not registered yet. The click buffers a single (path, line, column)
// target here; `MonacoView` consumes it on mount for the matching path so the
// scroll/caret still lands. A target for a different path is discarded.
interface PendingReveal {
  path: string;
  line: number;
  column: number;
}

let pendingReveal: PendingReveal | null = null;

/** Buffer a reveal target to be flushed when `path` mounts (single-consume). */
export function requestReveal(path: string, line: number, column: number): void {
  pendingReveal = { path, line, column };
}

/**
 * Consume and return the buffered reveal target for `path`, or `null` when none
 * is buffered for that path. Consuming clears the buffer so it fires once; a
 * buffered target for a different path is discarded (returns `null`) so a stale
 * target never lands on the wrong file.
 */
export function takePendingReveal(path: string): { line: number; column: number } | null {
  const target = pendingReveal;
  if (!target) return null;
  pendingReveal = null;
  if (target.path !== path) return null;
  return { line: target.line, column: target.column };
}

// ── Cursor position (Phase 14 status bar) ──────────────────────────────────
export interface CursorPosition {
  line: number;
  column: number;
}

let cursor: CursorPosition | null = null;
const cursorListeners = new Set<() => void>();

export function setCursorPosition(pos: CursorPosition | null): void {
  cursor = pos;
  for (const fn of cursorListeners) fn();
}

export function getCursorPosition(): CursorPosition | null {
  return cursor;
}

export function subscribeCursor(fn: () => void): () => void {
  cursorListeners.add(fn);
  return () => cursorListeners.delete(fn);
}
