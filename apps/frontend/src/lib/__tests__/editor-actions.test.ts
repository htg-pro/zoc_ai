import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEditor,
  formatDocument,
  getActiveSelection,
  goToLine,
  goToSymbolInFile,
  hasActiveEditor,
  revealLine,
  runEditorAction,
  setActiveEditor,
} from "@/lib/editor-actions";

function makeEditor() {
  const run = vi.fn();
  const selection = { startLineNumber: 1, endLineNumber: 1 };
  return {
    getAction: vi.fn((id: string) => (id === "missing" ? null : { run })),
    getModel: vi.fn(() => ({ getValueInRange: vi.fn(() => "selected code") })),
    getSelection: vi.fn(() => selection),
    revealLineInCenter: vi.fn(),
    setPosition: vi.fn(),
    focus: vi.fn(),
    _run: run,
  };
}

afterEach(() => {
  // Reset module-level active editor between tests.
  setActiveEditor(null);
});

describe("editor-actions", () => {
  it("reports whether an editor is active", () => {
    expect(hasActiveEditor()).toBe(false);
    const ed = makeEditor();
    setActiveEditor(ed);
    expect(hasActiveEditor()).toBe(true);
    setActiveEditor(null);
    expect(hasActiveEditor()).toBe(false);
  });

  it("runEditorAction returns false with no active editor", () => {
    expect(runEditorAction("editor.action.formatDocument")).toBe(false);
  });

  it("reads the focused editor selection", () => {
    expect(getActiveSelection()).toBeNull();
    setActiveEditor(makeEditor());
    expect(getActiveSelection()).toBe("selected code");
  });

  it("runEditorAction runs the named action and returns true", () => {
    const ed = makeEditor();
    setActiveEditor(ed);
    expect(runEditorAction("editor.action.formatDocument")).toBe(true);
    expect(ed.getAction).toHaveBeenCalledWith("editor.action.formatDocument");
    expect(ed._run).toHaveBeenCalledOnce();
  });

  it("runEditorAction returns false when the action does not exist", () => {
    setActiveEditor(makeEditor());
    expect(runEditorAction("missing")).toBe(false);
  });

  it("format/goto helpers delegate to the right Monaco action ids", () => {
    const ed = makeEditor();
    setActiveEditor(ed);
    formatDocument();
    goToLine();
    goToSymbolInFile();
    const ids = ed.getAction.mock.calls.map((c) => c[0]);
    expect(ids).toEqual([
      "editor.action.formatDocument",
      "editor.action.gotoLine",
      "editor.action.quickOutline",
    ]);
  });

  it("revealLine moves caret, reveals and focuses", () => {
    const ed = makeEditor();
    setActiveEditor(ed);
    revealLine(42);
    expect(ed.revealLineInCenter).toHaveBeenCalledWith(42);
    expect(ed.setPosition).toHaveBeenCalledWith({ lineNumber: 42, column: 1 });
    expect(ed.focus).toHaveBeenCalledOnce();
  });

  it("clearActiveEditor only clears the matching editor", () => {
    const a = makeEditor();
    const b = makeEditor();
    setActiveEditor(a);
    clearActiveEditor(b); // different instance — no-op
    expect(hasActiveEditor()).toBe(true);
    clearActiveEditor(a);
    expect(hasActiveEditor()).toBe(false);
  });
});
