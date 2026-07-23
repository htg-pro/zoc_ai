import { afterEach, describe, expect, it, vi } from "vitest";
import {
  revealPosition,
  requestReveal,
  setActiveEditor,
  takePendingReveal,
} from "../editor-actions";

afterEach(() => {
  setActiveEditor(null);
  // Drain any leftover pending target so tests are independent.
  takePendingReveal("__drain__");
});

describe("editor-actions revealPosition (task 3.2, R3.2/R3.3)", () => {
  it("fires revealLineInCenter, setPosition, and focus on the active editor", () => {
    const revealLineInCenter = vi.fn();
    const setPosition = vi.fn();
    const focus = vi.fn();
    setActiveEditor({ revealLineInCenter, setPosition, focus });

    revealPosition(12, 5);

    expect(revealLineInCenter).toHaveBeenCalledWith(12);
    expect(setPosition).toHaveBeenCalledWith({ lineNumber: 12, column: 5 });
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (does not throw) when no editor is active", () => {
    setActiveEditor(null);
    expect(() => revealPosition(3, 4)).not.toThrow();
  });
});

describe("editor-actions pending reveal buffer (task 3.2)", () => {
  it("buffers a target and consumes it exactly once for the matching path", () => {
    requestReveal("/a/b.ts", 7, 2);
    expect(takePendingReveal("/a/b.ts")).toEqual({ line: 7, column: 2 });
    // Consumed: a second read returns null.
    expect(takePendingReveal("/a/b.ts")).toBeNull();
  });

  it("discards a stale target buffered for a different path", () => {
    requestReveal("/a/b.ts", 7, 2);
    // A different file mounts first — the stale target must not land on it.
    expect(takePendingReveal("/c/d.ts")).toBeNull();
    // And it is cleared, so the original path also sees nothing now.
    expect(takePendingReveal("/a/b.ts")).toBeNull();
  });

  it("returns null when nothing is buffered", () => {
    expect(takePendingReveal("/anything.ts")).toBeNull();
  });
});
