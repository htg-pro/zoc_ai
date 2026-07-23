import type { ReactNode } from "react";
import { render, screen } from "@testing-library/react";
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
  onMount?: (editor: unknown, monaco: unknown) => void;
};

const registerSpy = vi.hoisted(() => vi.fn(() => ({ dispose: vi.fn() })));

vi.mock("@monaco-editor/react", async () => {
  const React = await import("react");
  return {
    default: (props: MockEditorProps) => {
      React.useEffect(() => {
        const editor = {
          onDidFocusEditorText: vi.fn(),
          getPosition: () => ({ lineNumber: 1, column: 1 }),
          onDidChangeCursorPosition: vi.fn(),
          createDecorationsCollection: () => ({ set: vi.fn() }),
          onMouseDown: vi.fn(),
          addAction: vi.fn(),
          getDomNode: () => null,
          layout: vi.fn(),
          trigger: vi.fn(),
        };
        const monaco = {
          KeyMod: { CtrlCmd: 2048 },
          KeyCode: { KeyK: 41 },
          editor: { MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 } },
          languages: {
            registerInlineCompletionsProvider: registerSpy,
            InlineCompletionTriggerKind: { Automatic: 0, Explicit: 1 },
          },
        };
        props.onMount?.(editor, monaco);
      }, []);
      return React.createElement("div", { "data-testid": "mock-monaco-editor" });
    },
  };
});

vi.mock("@/features/editor/lsp/monaco-services", () => ({
  captureMonaco: vi.fn(),
  ensureServicesInitialized: vi.fn(async () => undefined),
  toMonacoModelUri: (p: string) => `file://${p}`,
}));

import { MonacoView } from "@/features/editor/MonacoView";
import type { OpenFile } from "@/lib/store";

const file: OpenFile = {
  path: "/src/App.tsx",
  name: "App.tsx",
  language: "typescript",
  content: "export function App() {}\n",
  dirty: false,
};

describe("MonacoView inline completions registration (R8.1)", () => {
  beforeEach(() => registerSpy.mockClear());

  it("registers the inline completions provider once on mount", async () => {
    render(<MonacoView file={file} />);
    await screen.findByTestId("mock-monaco-editor");
    expect(registerSpy).toHaveBeenCalledTimes(1);
  });
});
