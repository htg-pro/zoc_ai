/**
 * Agent edit animator — Part 8.1.
 *
 * The pure planner resolves SearchReplace steps against one model snapshot.
 * The animator then applies those resolved edits through Monaco one at a time,
 * preserving a single undo group while making every step visible.
 */

/** A single SearchReplace edit (Aider/Cursor-style block). */
export interface SearchReplaceEdit {
  search: string;
  replace: string;
  /** Required only for a pure insertion whose search text is empty. */
  startLineNumber?: number;
}

/** 1-based Monaco range (structurally compatible with `monaco.IRange`). */
export interface EditRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** A resolved edit expressed in the original and final model coordinates. */
export interface PlannedEdit {
  range: EditRange;
  insertText: string;
  decorationRange: EditRange;
}

/** Convert a 0-based char offset in `text` to a 1-based Monaco position. */
export function offsetToPosition(
  text: string,
  offset: number,
): { lineNumber: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lastNewline = i;
    }
  }
  return { lineNumber: line, column: clamped - lastNewline };
}

/** Convert a 1-based Monaco position to a clamped 0-based offset. */
export function positionToOffset(
  text: string,
  position: { lineNumber: number; column: number },
): number {
  const targetLine = Math.max(1, position.lineNumber);
  let line = 1;
  let lineStart = 0;
  while (line < targetLine) {
    const newline = text.indexOf("\n", lineStart);
    if (newline === -1) return text.length;
    lineStart = newline + 1;
    line += 1;
  }
  const lineEnd = text.indexOf("\n", lineStart);
  const max = lineEnd === -1 ? text.length : lineEnd;
  return Math.max(lineStart, Math.min(lineStart + Math.max(0, position.column - 1), max));
}

function lineStartOffset(text: string, lineNumber: number): number {
  return positionToOffset(text, { lineNumber: Math.max(1, lineNumber), column: 1 });
}

/** Build a 1-based `EditRange` spanning the half-open [start, end) offsets. */
function rangeFromOffsets(text: string, start: number, end: number): EditRange {
  const s = offsetToPosition(text, start);
  const e = offsetToPosition(text, end);
  return {
    startLineNumber: s.lineNumber,
    startColumn: s.column,
    endLineNumber: e.lineNumber,
    endColumn: e.column,
  };
}

/** Resolve ordered, non-overlapping SearchReplace edits against `text`. */
export function computeEditPlan(text: string, edits: SearchReplaceEdit[]): PlannedEdit[] {
  interface ResolvedMatch {
    origStart: number;
    origEnd: number;
    replace: string;
  }

  const matches: ResolvedMatch[] = [];
  let cursor = 0;
  for (const edit of edits) {
    let at: number;
    if (edit.search.length === 0) {
      if (edit.startLineNumber === undefined) continue;
      at = Math.max(cursor, lineStartOffset(text, edit.startLineNumber));
    } else {
      at = text.indexOf(edit.search, cursor);
      if (at === -1) continue;
    }
    matches.push({ origStart: at, origEnd: at + edit.search.length, replace: edit.replace });
    cursor = at + edit.search.length;
  }

  let assembled = "";
  let read = 0;
  const finalStarts: number[] = [];
  for (const match of matches) {
    assembled += text.slice(read, match.origStart);
    finalStarts.push(assembled.length);
    assembled += match.replace;
    read = match.origEnd;
  }
  assembled += text.slice(read);

  return matches.map((match, index) => {
    const finalStart = finalStarts[index];
    return {
      range: rangeFromOffsets(text, match.origStart, match.origEnd),
      insertText: match.replace,
      decorationRange: rangeFromOffsets(
        assembled,
        finalStart,
        finalStart + match.replace.length,
      ),
    };
  });
}

/** Build one exact replacement plan for the Cmd+K overlay. */
export function singleReplacePlan(
  text: string,
  startOffset: number,
  endOffset: number,
  replacement: string,
): PlannedEdit {
  const lo = Math.max(0, Math.min(startOffset, text.length));
  const hi = Math.max(lo, Math.min(endOffset, text.length));
  const finalText = text.slice(0, lo) + replacement + text.slice(hi);
  return {
    range: rangeFromOffsets(text, lo, hi),
    insertText: replacement,
    decorationRange: rangeFromOffsets(finalText, lo, lo + replacement.length),
  };
}

export interface AnimatorDecorationsCollection {
  set(decorations: unknown[]): void;
  clear(): void;
}

export interface AnimatorEditorHandle {
  getModel(): { getValue(): string } | null;
  pushUndoStop?: () => void;
  executeEdits(source: string, edits: Array<{ range: EditRange; text: string }>): void;
  createDecorationsCollection(initial?: unknown[]): AnimatorDecorationsCollection;
  setPosition?: (position: { lineNumber: number; column: number }) => void;
  revealRangeInCenterIfOutsideViewport?: (range: EditRange) => void;
}

export interface AnimatorClock {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
}

export interface AnimatorToastOptions {
  description?: string;
  duration?: number;
}

export interface AnimatorToast {
  success(message: string, options?: AnimatorToastOptions): void;
  error?(message: string, options?: AnimatorToastOptions): void;
}

export interface AgentEditMeta {
  filePath?: string;
  adds?: number;
  dels?: number;
  /** Captured model snapshot; mismatch cancels rather than overwriting. */
  baseText?: string;
}

export interface AgentEditAnimatorOptions {
  editor: AnimatorEditorHandle;
  clock?: AnimatorClock;
  toast?: AnimatorToast;
  flashClassName?: string;
  cadenceMs?: number;
  holdMs?: number;
}

const REAL_CLOCK: AnimatorClock = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

interface ResolvedSequentialEdit {
  plan: PlannedEdit;
  originalStart: number;
  originalEnd: number;
  originalText: string;
}

/** Applies a plan step-by-step while keeping all steps in one Monaco undo group. */
export class AgentEditAnimator {
  private readonly editor: AnimatorEditorHandle;
  private readonly clock: AnimatorClock;
  private readonly toast?: AnimatorToast;
  private readonly flashClassName: string;
  private readonly cadenceMs: number;
  private readonly holdMs: number;
  private readonly decorations: AnimatorDecorationsCollection;
  private readonly flashTimers = new Set<number>();
  private readonly waiters = new Map<number, (ready: boolean) => void>();
  private active: EditRange[] = [];
  private generation = 0;
  private disposed = false;

  constructor(opts: AgentEditAnimatorOptions) {
    this.editor = opts.editor;
    this.clock = opts.clock ?? REAL_CLOCK;
    this.toast = opts.toast;
    this.flashClassName = opts.flashClassName ?? "agent-edit-flash";
    this.cadenceMs = Math.max(0, opts.cadenceMs ?? 50);
    this.holdMs = Math.max(0, opts.holdMs ?? 1500);
    this.decorations = opts.editor.createDecorationsCollection([]);
  }

  /** Resolve against the live model and refuse a partial/stale SearchReplace set. */
  async applyEdits(
    edits: SearchReplaceEdit[],
    meta?: AgentEditMeta,
  ): Promise<PlannedEdit[]> {
    const text = this.editor.getModel()?.getValue() ?? "";
    const plan = computeEditPlan(text, edits);
    if (plan.length !== edits.length) {
      this.toast?.error?.("Agent edit no longer matches the open buffer", {
        description: meta?.filePath,
      });
      return [];
    }
    return this.applyPlan(plan, meta);
  }

  /** Apply each edit at a 50 ms cadence, with stale-buffer cancellation. */
  async applyPlan(plan: PlannedEdit[], meta?: AgentEditMeta): Promise<PlannedEdit[]> {
    if (this.disposed || plan.length === 0) return [];
    this.cancel();
    const generation = this.generation;
    const model = this.editor.getModel();
    if (!model) return [];

    const original = model.getValue();
    if (meta?.baseText !== undefined && original !== meta.baseText) {
      this.toast?.error?.("Agent edit cancelled because the buffer changed", {
        description: meta.filePath,
      });
      return [];
    }
    const resolved: ResolvedSequentialEdit[] = plan.map((item) => {
      const originalStart = positionToOffset(original, {
        lineNumber: item.range.startLineNumber,
        column: item.range.startColumn,
      });
      const originalEnd = positionToOffset(original, {
        lineNumber: item.range.endLineNumber,
        column: item.range.endColumn,
      });
      return {
        plan: item,
        originalStart,
        originalEnd,
        originalText: original.slice(originalStart, originalEnd),
      };
    });

    let expected = original;
    let delta = 0;
    const applied: PlannedEdit[] = [];
    this.editor.pushUndoStop?.();

    for (let index = 0; index < resolved.length; index++) {
      if (index > 0 && !(await this.wait(this.cadenceMs, generation))) break;
      if (this.disposed || generation !== this.generation) break;

      const current = this.editor.getModel()?.getValue();
      if (current === undefined || current !== expected) {
        this.toast?.error?.("Agent edit cancelled because the buffer changed", {
          description: meta?.filePath,
        });
        break;
      }

      const item = resolved[index];
      const start = item.originalStart + delta;
      const end = item.originalEnd + delta;
      if (current.slice(start, end) !== item.originalText) {
        this.toast?.error?.("Agent edit no longer matches the open buffer", {
          description: meta?.filePath,
        });
        break;
      }

      const range = rangeFromOffsets(current, start, end);
      const next = current.slice(0, start) + item.plan.insertText + current.slice(end);
      const decorationRange = rangeFromOffsets(
        next,
        start,
        start + item.plan.insertText.length,
      );
      this.editor.executeEdits("agent-edit-animator", [
        { range, text: item.plan.insertText },
      ]);
      expected = next;
      delta += item.plan.insertText.length - (item.originalEnd - item.originalStart);
      applied.push({ ...item.plan, decorationRange });

      const endPosition = {
        lineNumber: decorationRange.endLineNumber,
        column: decorationRange.endColumn,
      };
      this.editor.setPosition?.(endPosition);
      this.editor.revealRangeInCenterIfOutsideViewport?.(decorationRange);
      this.flash(decorationRange);
    }

    if (applied.length > 0) this.editor.pushUndoStop?.();
    if (applied.length === plan.length) this.showToast(applied, resolved, meta);
    return applied;
  }

  private showToast(
    applied: PlannedEdit[],
    resolved: ResolvedSequentialEdit[],
    meta?: AgentEditMeta,
  ): void {
    if (!this.toast) return;
    const adds = meta?.adds ?? applied.reduce((sum, item) => sum + lineCount(item.insertText), 0);
    const dels = meta?.dels ?? resolved.reduce((sum, item) => sum + lineCount(item.originalText), 0);
    const fileName = basename(meta?.filePath ?? "file");
    this.toast.success(`Edited ${fileName} (+${adds} -${dels} lines)`, {
      ...(meta?.filePath ? { description: meta.filePath } : {}),
      duration: 1000,
    });
  }

  private flash(range: EditRange): void {
    this.active.push(range);
    this.renderDecorations();
    const handle = this.clock.setTimeout(() => {
      this.flashTimers.delete(handle);
      this.active = this.active.filter((candidate) => candidate !== range);
      this.renderDecorations();
    }, this.holdMs);
    this.flashTimers.add(handle);
  }

  private wait(ms: number, generation: number): Promise<boolean> {
    if (ms === 0) return Promise.resolve(generation === this.generation);
    return new Promise((resolve) => {
      const handle = this.clock.setTimeout(() => {
        this.waiters.delete(handle);
        resolve(generation === this.generation && !this.disposed);
      }, ms);
      this.waiters.set(handle, resolve);
    });
  }

  private renderDecorations(): void {
    this.decorations.set(
      this.active.map((range) => ({
        range,
        options: { className: this.flashClassName, isWholeLine: false },
      })),
    );
  }

  /** Cancel pending steps and remove every transient decoration. */
  cancel(): void {
    this.generation += 1;
    for (const [handle, resolve] of this.waiters) {
      this.clock.clearTimeout(handle);
      resolve(false);
    }
    this.waiters.clear();
    for (const handle of this.flashTimers) this.clock.clearTimeout(handle);
    this.flashTimers.clear();
    this.active = [];
    this.renderDecorations();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel();
    try {
      this.decorations.clear();
    } catch {
      // Monaco may already have disposed the model/collection.
    }
  }
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) ?? "file";
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r?\n/).length;
  return text.endsWith("\n") ? Math.max(0, lines - 1) : lines;
}
