import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInlineCompletionsProvider } from "@/features/editor/inline-completions";
import type { CompletionRequestBody } from "@/lib/completions-client";

// ── Fake Monaco namespace for the provider-level tests ───────────────────────
function fakeMonaco() {
  const registered: unknown[] = [];
  const dispose = vi.fn();
  const monaco = {
    languages: {
      registerInlineCompletionsProvider: vi.fn((_selector: unknown, provider: unknown) => {
        registered.push(provider);
        return { dispose };
      }),
      InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
    },
  };
  return { monaco, registered, dispose };
}

function fakeModel(text: string, offset: number) {
  return {
    getValue: () => text,
    getOffsetAt: () => offset,
    getLanguageId: () => "typescript",
    uri: { path: "/src/app.ts", toString: () => "file:///src/app.ts" },
  };
}

describe("createInlineCompletionsProvider registration (R8.1)", () => {
  it("registers exactly one provider against the Monaco instance and disposes it", () => {
    const { monaco, dispose } = fakeMonaco();
    const reg = createInlineCompletionsProvider(monaco as never, {
      streamCompletion: async () => {},
    });
    expect(monaco.languages.registerInlineCompletionsProvider).toHaveBeenCalledTimes(1);
    const [selector, provider] = monaco.languages.registerInlineCompletionsProvider.mock.calls[0];
    expect(selector).toEqual({ pattern: "**" });
    expect(typeof (provider as { provideInlineCompletions: unknown }).provideInlineCompletions).toBe(
      "function",
    );
    reg.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("returns the streamed ghost text as an inline item, and no items when empty (R10.1/R16.3)", () => {
    const { monaco } = fakeMonaco();
    // Explicit trigger streams synchronously so the item reflects the tokens.
    const withTokens = createInlineCompletionsProvider(monaco as never, {
      streamCompletion: async (_b: CompletionRequestBody, onToken) => {
        onToken("foo(");
        onToken(")");
      },
    });
    const provider = (monaco.languages.registerInlineCompletionsProvider.mock.calls[0][1]) as {
      provideInlineCompletions: (m: unknown, p: unknown, c: unknown, t: unknown) => { items: Array<{ insertText: string }> };
    };
    const result = provider.provideInlineCompletions(
      fakeModel("const x = ", 10),
      { lineNumber: 1, column: 11 },
      { triggerKind: 1 }, // Explicit
      {},
    );
    expect(result.items).toEqual([{ insertText: "foo()" }]);
    withTokens.dispose();

    // An empty completion yields no items (no ghost text, no hint).
    const { monaco: monaco2 } = fakeMonaco();
    createInlineCompletionsProvider(monaco2 as never, { streamCompletion: async () => {} });
    const provider2 = (monaco2.languages.registerInlineCompletionsProvider.mock.calls[0][1]) as {
      provideInlineCompletions: (m: unknown, p: unknown, c: unknown, t: unknown) => { items: unknown[] };
    };
    const empty = provider2.provideInlineCompletions(
      fakeModel("", 0),
      { lineNumber: 1, column: 1 },
      { triggerKind: 1 },
      {},
    );
    expect(empty.items).toEqual([]);
  });
});

// ── MonacoView mount registers the provider once (R8.1) ──────────────────────
type MockEditorProps = {
  loading?: ReactNode;
  value?: string;
  onMount?: (editor: unknown, monaco: unknown) => void;
};

const registerSpy = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));
const addActionSpy = vi.hoisted(() => vi.fn());
const executeEditsSpy = vi.hoisted(() => vi.fn());
const setPositionSpy = vi.hoisted(() => vi.fn());
const revealRangeSpy = vi.hoisted(() => vi.fn());
const streamInlineEditSpy = vi.hoisted(() => vi.fn(async (_request: unknown) => "edited"));

vi.mock("@/features/chat/wire/inline-edit-client", () => ({
  streamInlineEdit: streamInlineEditSpy,
}));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  return {
    default: function MockEditor({ onMount, value = "" }: MockEditorProps) {
      const textRef = React.useRef(value);
      React.useEffect(() => {
        const offsetAt = (
          text: string,
          position: { lineNumber: number; column: number },
        ): number => {
          const lines = text.split("\n");
          return (
            lines
              .slice(0, Math.max(0, position.lineNumber - 1))
              .reduce((total, line) => total + line.length + 1, 0) +
            Math.max(0, position.column - 1)
          );
        };
        const editor = {
          onDidFocusEditorText: vi.fn(),
          getPosition: () => ({ lineNumber: 1, column: 1 }),
          onDidChangeCursorPosition: vi.fn(),
          getModel: () => ({ getValue: () => textRef.current }),
          pushUndoStop: vi.fn(),
          executeEdits: (
            source: string,
            edits: Array<{
              range: {
                startLineNumber: number;
                startColumn: number;
                endLineNumber: number;
                endColumn: number;
              };
              text: string;
            }>,
          ) => {
            executeEditsSpy(source, edits);
            for (const edit of [...edits].reverse()) {
              const start = offsetAt(textRef.current, {
                lineNumber: edit.range.startLineNumber,
                column: edit.range.startColumn,
              });
              const end = offsetAt(textRef.current, {
                lineNumber: edit.range.endLineNumber,
                column: edit.range.endColumn,
              });
              textRef.current =
                textRef.current.slice(0, start) + edit.text + textRef.current.slice(end);
            }
          },
          setPosition: setPositionSpy,
          revealRangeInCenterIfOutsideViewport: revealRangeSpy,
          createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
          onMouseDown: vi.fn(),
          addAction: addActionSpy,
          getDomNode: () => null,
          layout: vi.fn(),
          trigger: vi.fn(),
        };
        const monaco = {
          Range: class {
            constructor(
              public startLineNumber: number,
              public startColumn: number,
              public endLineNumber: number,
              public endColumn: number,
            ) {}
          },
          KeyMod: { CtrlCmd: 2048 },
          KeyCode: { KeyK: 41 },
          editor: {
            MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
            setModelMarkers: vi.fn(),
            MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
          },
          languages: {
            registerInlineCompletionsProvider: registerSpy,
            InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
          },
        };
        onMount?.(editor, monaco);
      }, [onMount]);
      return React.createElement("div", { "data-testid": "mock-monaco-editor" });
    },
    DiffEditor: () => React.createElement("div", { "data-testid": "mock-diff-editor" }),
  };
});

vi.mock("@/features/editor/lsp/monaco-services", () => ({
  captureMonaco: vi.fn(),
  ensureServicesInitialized: vi.fn(async () => undefined),
  toMonacoModelUri: (p: string) => `file://${p}`,
}));

import { MonacoView } from "@/features/editor/MonacoView";
import {
  commitAgentEditBatch,
  resetAgentEditBridgeForTests,
  stageAgentEditBatch,
} from "@/features/editor/agent-edit-bridge";
import { useApp, type OpenFile } from "@/lib/store";

const file: OpenFile = {
  path: "/src/App.tsx",
  name: "App.tsx",
  language: "typescript",
  content: "export function App() {}\n",
  dirty: false,
};

describe("MonacoView inline completions registration (R8.1)", () => {
  beforeEach(() => {
    registerSpy.mockClear();
    addActionSpy.mockClear();
    executeEditsSpy.mockClear();
    setPositionSpy.mockClear();
    revealRangeSpy.mockClear();
    streamInlineEditSpy.mockClear();
    resetAgentEditBridgeForTests();
    useApp.setState({ openFiles: [file], activeFile: file.path });
  });

  it("registers the inline completions provider once on mount", async () => {
    render(<MonacoView file={file} />);
    await screen.findByTestId("mock-monaco-editor");
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });

  it("animates a committed agent review into the mounted buffer and marks it clean", async () => {
    render(<MonacoView file={file} />);
    await screen.findByTestId("mock-monaco-editor");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    stageAgentEditBatch("run-applied", [
      {
        path: "src/App.tsx",
        diff:
          "@@ -1 +1 @@\n-export function App() {}\n+export const App = () => {}\n",
        adds: 1,
        dels: 1,
      },
    ]);
    expect(commitAgentEditBatch("run-applied")).toBe(1);

    await waitFor(() => {
      expect(useApp.getState().openFiles[0]).toEqual(
        expect.objectContaining({
          content: "export const App = () => {}\n",
          dirty: false,
        }),
      );
    });
    expect(executeEditsSpy).toHaveBeenCalledWith("agent-edit-animator", [
      expect.objectContaining({ text: "export const App = () => {}\n" }),
    ]);
    expect(setPositionSpy).toHaveBeenCalled();
    expect(revealRangeSpy).toHaveBeenCalled();
  });

  it("does not replay an applied agent diff over a dirty user buffer", async () => {
    const dirtyFile = { ...file, content: "unsaved user edit\n", dirty: true };
    useApp.setState({ openFiles: [dirtyFile], activeFile: dirtyFile.path });
    render(<MonacoView file={dirtyFile} />);
    await screen.findByTestId("mock-monaco-editor");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    stageAgentEditBatch("run-dirty", [
      {
        path: "src/App.tsx",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
        adds: 1,
        dels: 1,
      },
    ]);
    expect(commitAgentEditBatch("run-dirty")).toBe(1);
    await act(async () => {
      await Promise.resolve();
    });

    expect(executeEditsSpy).not.toHaveBeenCalled();
    expect(useApp.getState().openFiles[0]).toEqual(
      expect.objectContaining({ content: "unsaved user edit\n", dirty: true }),
    );
  });

  it("uses the current line and at most 200 surrounding characters for an empty Cmd+K selection", async () => {
    const content = `${"x".repeat(250)}\nbeta\n${"y".repeat(250)}`;
    render(<MonacoView file={{ ...file, content }} />);
    await screen.findByTestId("mock-monaco-editor");

    const lines = content.split("\n");
    const lineStarts = lines.map((_, index) =>
      lines.slice(0, index).reduce((total, line) => total + line.length + 1, 0),
    );
    const offsetAt = (position: { lineNumber: number; column: number }): number =>
      lineStarts[position.lineNumber - 1] + position.column - 1;
    const model = {
      getValue: () => content,
      getLineContent: (lineNumber: number) => lines[lineNumber - 1],
      getLineMaxColumn: (lineNumber: number) => lines[lineNumber - 1].length + 1,
      getOffsetAt: offsetAt,
      getValueInRange: (range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      }) =>
        content.slice(
          offsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }),
          offsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }),
        ),
    };
    const selection = {
      startLineNumber: 2,
      startColumn: 3,
      endLineNumber: 2,
      endColumn: 3,
      isEmpty: () => true,
      getStartPosition: () => ({ lineNumber: 2, column: 3 }),
      getEndPosition: () => ({ lineNumber: 2, column: 3 }),
    };
    const action = addActionSpy.mock.calls
      .map(([candidate]) => candidate as { id: string; run: (editor: unknown) => void })
      .find((candidate) => candidate.id === "zoc.inline-edit");
    expect(action).toBeDefined();

    act(() => {
      action?.run({
        getModel: () => model,
        getSelection: () => selection,
        getScrolledVisiblePosition: () => ({ top: 100, left: 0, height: 20 }),
      });
    });

    const prompt = screen.getByPlaceholderText("Edit selected code with AI...");
    fireEvent.change(prompt, { target: { value: "make it uppercase" } });
    fireEvent.keyDown(prompt, { key: "Enter" });

    await waitFor(() => expect(streamInlineEditSpy).toHaveBeenCalledTimes(1));
    const request = streamInlineEditSpy.mock.calls[0][0] as {
      code: string;
      prefix: string;
      suffix: string;
    };
    expect(request.code).toBe("beta");
    expect(request.prefix).toHaveLength(200);
    expect(request.suffix).toHaveLength(200);
  });
});
