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
