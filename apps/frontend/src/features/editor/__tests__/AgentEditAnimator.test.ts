import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  AgentEditAnimator,
  computeEditPlan,
  offsetToPosition,
  positionToOffset,
  singleReplacePlan,
  type AnimatorClock,
  type AnimatorEditorHandle,
  type EditRange,
  type SearchReplaceEdit,
} from "../AgentEditAnimator";

describe("offsetToPosition", () => {
  it("maps single-line offsets to 1-based columns", () => {
    expect(offsetToPosition("hello", 0)).toEqual({ lineNumber: 1, column: 1 });
    expect(offsetToPosition("hello", 5)).toEqual({ lineNumber: 1, column: 6 });
  });

  it("maps offsets across newlines to the right line/column", () => {
    const text = "foo\nbar\nbaz";
    expect(offsetToPosition(text, 4)).toEqual({ lineNumber: 2, column: 1 }); // 'b' of bar
    expect(offsetToPosition(text, 7)).toEqual({ lineNumber: 2, column: 4 }); // end of bar
    expect(offsetToPosition(text, 8)).toEqual({ lineNumber: 3, column: 1 }); // 'b' of baz
  });

  it("clamps out-of-range offsets", () => {
    expect(offsetToPosition("ab", -5)).toEqual({ lineNumber: 1, column: 1 });
    expect(offsetToPosition("ab", 99)).toEqual({ lineNumber: 1, column: 3 });
  });

  it("Property: line == 1 + count of newlines before the offset; column >= 1", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 400 }), fc.nat(), (text, rawOffset) => {
        const offset = Math.min(rawOffset, text.length);
        const before = text.slice(0, offset);
        const expectedLine = 1 + (before.match(/\n/g)?.length ?? 0);
        const lastNl = before.lastIndexOf("\n");
        const expectedColumn = lastNl === -1 ? offset + 1 : offset - lastNl;
        const pos = offsetToPosition(text, offset);
        expect(pos.lineNumber).toBe(expectedLine);
        expect(pos.column).toBe(expectedColumn);
        expect(pos.column).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });
});

describe("computeEditPlan", () => {
  it("resolves a single same-length edit to the matching range", () => {
    const plan = computeEditPlan("hello world", [{ search: "world", replace: "there" }]);
    expect(plan).toHaveLength(1);
    expect(plan[0].range).toEqual({
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 1,
      endColumn: 12,
    });
    expect(plan[0].insertText).toBe("there");
    // Same length → decoration lands on the same range.
    expect(plan[0].decorationRange).toEqual(plan[0].range);
  });

  it("later decoration ranges account for earlier edits' length delta", () => {
    // "A" (len 1) → "XXXX" (len 4) grows the text by 3, shifting "B" right.
    const plan = computeEditPlan("AAB", [
      { search: "A", replace: "XXXX" },
      { search: "B", replace: "Y" },
    ]);
    expect(plan).toHaveLength(2);

    // Edit 1 replaces the first "A" at offset 0 (original coords).
    expect(plan[0].range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    });
    // "XXXX" occupies cols 1..5 in the FINAL text "XXXXAY".
    expect(plan[0].decorationRange).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    });

    // Edit 2 matches "B" at original offset 2 (indexOf from cursor 1).
    expect(plan[1].range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 4,
    });
    // "Y" is the 6th char of "XXXXAY" → cols 6..7 (accounts for +3 delta).
    expect(plan[1].decorationRange).toEqual({
      startLineNumber: 1,
      startColumn: 6,
      endLineNumber: 1,
      endColumn: 7,
    });
  });

  it("skips searches that do not match", () => {
    expect(computeEditPlan("abc", [{ search: "zzz", replace: "Q" }])).toEqual([]);
  });

  it("skips empty searches", () => {
    expect(computeEditPlan("abc", [{ search: "", replace: "Q" }])).toEqual([]);
  });

  it("matches repeated searches left-to-right and skips those past the end", () => {
    const plan = computeEditPlan("xx", [
      { search: "x", replace: "A" },
      { search: "x", replace: "B" },
      { search: "x", replace: "C" }, // no third "x" at/after cursor → skipped
    ]);
    expect(plan.map((p) => p.insertText)).toEqual(["A", "B"]);
    expect(plan[0].range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    });
    expect(plan[1].range).toEqual({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 1,
      endColumn: 3,
    });
  });

  it("resolves multi-line searches to multi-line ranges", () => {
    const plan = computeEditPlan("foo\nbar\nbaz", [{ search: "bar", replace: "QUX" }]);
    expect(plan[0].range).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 4,
    });
    expect(plan[0].decorationRange).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 4,
    });
  });

  it("Property: ranges are ordered and non-overlapping (original coords)", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom("a", "b", "c"), { maxLength: 20 }), (chars) => {
        const text = chars.join("");
        const edits: SearchReplaceEdit[] = chars.map((c) => ({ search: c, replace: c.toUpperCase() }));
        const plan = computeEditPlan(text, edits);
        for (let i = 1; i < plan.length; i++) {
          const prev = plan[i - 1].range;
          const cur = plan[i].range;
          // Strictly advancing start columns on a single line → no overlap.
          expect(cur.startColumn).toBeGreaterThanOrEqual(prev.endColumn);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("singleReplacePlan", () => {
  it("builds a plan from an explicit offset range", () => {
    const plan = singleReplacePlan("hello world", 6, 11, "there");
    expect(plan.range).toEqual({
      startLineNumber: 1,
      startColumn: 7,
      endLineNumber: 1,
      endColumn: 12,
    });
    expect(plan.insertText).toBe("there");
    expect(plan.decorationRange).toEqual(plan.range);
  });

  it("computes a grown decoration range for a longer replacement", () => {
    // Replace "a" (offset 0..1) with "XYZ" in "ab" → final "XYZb".
    const plan = singleReplacePlan("ab", 0, 1, "XYZ");
    expect(plan.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 2,
    });
    expect(plan.decorationRange).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    });
  });

  it("clamps and orders out-of-range offsets", () => {
    const plan = singleReplacePlan("abc", 5, 1, "Z");
    // lo=min(5,3)=3, hi=max(3,min(1,3))=3 → zero-width insert at end.
    expect(plan.range).toEqual({
      startLineNumber: 1,
      startColumn: 4,
      endLineNumber: 1,
      endColumn: 4,
    });
  });
});


class FakeClock implements AnimatorClock {
  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { at: number; handler: () => void }>();

  setTimeout(handler: () => void, ms: number): number {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.now + ms, handler });
    return id;
  }

  clearTimeout(handle: number): void {
    this.tasks.delete(handle);
  }

  advance(ms: number): void {
    this.now += ms;
    while (true) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) return;
      this.tasks.delete(due[0]);
      due[1].handler();
    }
  }

  pending(): number {
    return this.tasks.size;
  }
}

class FakeEditor implements AnimatorEditorHandle {
  text: string;
  readonly pushUndoStop = vi.fn();
  readonly setPosition = vi.fn();
  readonly revealRangeInCenterIfOutsideViewport = vi.fn();
  readonly decorationSet = vi.fn();
  readonly decorationClear = vi.fn();
  readonly executeEdits = vi.fn(
    (_source: string, edits: Array<{ range: EditRange; text: string }>) => {
      for (const edit of [...edits].reverse()) {
        const start = positionToOffset(this.text, {
          lineNumber: edit.range.startLineNumber,
          column: edit.range.startColumn,
        });
        const end = positionToOffset(this.text, {
          lineNumber: edit.range.endLineNumber,
          column: edit.range.endColumn,
        });
        this.text = this.text.slice(0, start) + edit.text + this.text.slice(end);
      }
    },
  );

  constructor(text: string) {
    this.text = text;
  }

  getModel(): { getValue(): string } {
    return { getValue: () => this.text };
  }

  createDecorationsCollection() {
    return { set: this.decorationSet, clear: this.decorationClear };
  }
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("AgentEditAnimator", () => {
  it("applies one edit every 50 ms in one undo group and reports file stats", async () => {
    const editor = new FakeEditor("alpha\nbeta\n");
    const clock = new FakeClock();
    const toast = { success: vi.fn(), error: vi.fn() };
    const animator = new AgentEditAnimator({ editor, clock, toast });

    const pending = animator.applyEdits(
      [
        { search: "alpha", replace: "ALPHA" },
        { search: "beta", replace: "BETA" },
      ],
      { filePath: "/workspace/src/example.ts", adds: 2, dels: 2 },
    );

    expect(editor.executeEdits).toHaveBeenCalledTimes(1);
    expect(editor.text).toBe("ALPHA\nbeta\n");
    clock.advance(49);
    await flushMicrotasks();
    expect(editor.executeEdits).toHaveBeenCalledTimes(1);

    clock.advance(1);
    await flushMicrotasks();
    const applied = await pending;

    expect(applied).toHaveLength(2);
    expect(editor.text).toBe("ALPHA\nBETA\n");
    expect(editor.executeEdits).toHaveBeenNthCalledWith(1, "agent-edit-animator", [
      expect.objectContaining({ text: "ALPHA" }),
    ]);
    expect(editor.executeEdits).toHaveBeenNthCalledWith(2, "agent-edit-animator", [
      expect.objectContaining({ text: "BETA" }),
    ]);
    expect(editor.pushUndoStop).toHaveBeenCalledTimes(2);
    expect(editor.setPosition).toHaveBeenLastCalledWith({ lineNumber: 2, column: 5 });
    expect(editor.revealRangeInCenterIfOutsideViewport).toHaveBeenCalledTimes(2);
    expect(toast.success).toHaveBeenCalledWith(
      "Edited example.ts (+2 -2 lines)",
      { description: "/workspace/src/example.ts", duration: 1000 },
    );

    clock.advance(1500);
    expect(editor.decorationSet).toHaveBeenLastCalledWith([]);
  });

  it("cancels pending steps and clears timers/decorations", async () => {
    const editor = new FakeEditor("one two");
    const clock = new FakeClock();
    const animator = new AgentEditAnimator({ editor, clock });
    const pending = animator.applyEdits([
      { search: "one", replace: "ONE" },
      { search: "two", replace: "TWO" },
    ]);

    expect(editor.text).toBe("ONE two");
    animator.cancel();
    clock.advance(5000);
    const applied = await pending;

    expect(applied).toHaveLength(1);
    expect(editor.text).toBe("ONE two");
    expect(editor.decorationSet).toHaveBeenLastCalledWith([]);
    expect(clock.pending()).toBe(0);
  });

  it("stops rather than overwriting a user edit made between steps", async () => {
    const editor = new FakeEditor("one two");
    const clock = new FakeClock();
    const toast = { success: vi.fn(), error: vi.fn() };
    const animator = new AgentEditAnimator({ editor, clock, toast });
    const pending = animator.applyEdits([
      { search: "one", replace: "ONE" },
      { search: "two", replace: "TWO" },
    ]);

    editor.text = "ONE user two";
    clock.advance(50);
    await flushMicrotasks();
    const applied = await pending;

    expect(applied).toHaveLength(1);
    expect(editor.text).toBe("ONE user two");
    expect(toast.error).toHaveBeenCalledWith(
      "Agent edit cancelled because the buffer changed",
      { description: undefined },
    );
  });

  it("rejects a plan built from a stale captured model snapshot", async () => {
    const editor = new FakeEditor("user changed");
    const toast = { success: vi.fn(), error: vi.fn() };
    const animator = new AgentEditAnimator({ editor, toast });
    const plan = [singleReplacePlan("original", 0, 8, "replacement")];

    const applied = await animator.applyPlan(plan, {
      filePath: "/workspace/file.ts",
      baseText: "original",
    });

    expect(applied).toEqual([]);
    expect(editor.executeEdits).not.toHaveBeenCalled();
    expect(editor.text).toBe("user changed");
    expect(toast.error).toHaveBeenCalledWith(
      "Agent edit cancelled because the buffer changed",
      { description: "/workspace/file.ts" },
    );
  });

  it("supports an empty-search insertion at a unified-diff line anchor", () => {
    const plan = computeEditPlan("first\nthird\n", [
      { search: "", replace: "second\n", startLineNumber: 2 },
    ]);
    expect(plan).toHaveLength(1);
    expect(plan[0].range).toEqual({
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    });
  });
});
