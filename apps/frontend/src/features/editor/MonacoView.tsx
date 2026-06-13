import {
  Component,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ErrorInfo, ReactNode } from "react";
import type { OnMount } from "@monaco-editor/react";
import type { OpenFile } from "@/lib/store";
import { useApp } from "@/lib/store";
import { useReducedMotion } from "@/lib/reduced-motion";

const Editor = lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default })),
);

// Loosely-typed Monaco handles — we only touch a small, stable surface so we
// avoid a hard dependency on monaco's types in the view layer.
type MonacoEditor = Parameters<OnMount>[0];
type MonacoNamespace = Parameters<OnMount>[1];
type DecorationsCollection = NonNullable<
  ReturnType<NonNullable<MonacoEditor["createDecorationsCollection"]>>
>;

/**
 * Advanced Monaco surface (R3.9, R3.10).
 *
 * While the agent is editing the active file we decorate a moving window of
 * "agent editing" lines (highlight + left accent + glyph) and render a blinking
 * caret that advances line by line to simulate live typing. All motion is gated
 * behind `prefers-reduced-motion`: when reduced, a single static highlighted
 * line and a non-blinking caret are shown instead.
 */
export function MonacoView({
  file,
  agentEditing = false,
}: {
  file: OpenFile;
  agentEditing?: boolean;
}) {
  const update = useApp((s) => s.updateFile);
  const reducedMotion = useReducedMotion();

  const editorRef = useRef<MonacoEditor | null>(null);
  const monacoRef = useRef<MonacoNamespace | null>(null);
  const decorationsRef = useRef<DecorationsCollection | null>(null);
  const caretWidgetRef = useRef<{
    node: HTMLSpanElement;
    widget: unknown;
    position: { lineNumber: number; column: number };
  } | null>(null);
  const [mountTick, setMountTick] = useState(0);

  const editorOptions = useMemo(
    () => ({
      automaticLayout: true,
      fontFamily: "JetBrains Mono, ui-monospace, monospace",
      fontSize: 13,
      lineNumbers: "on" as const,
      glyphMargin: true,
      folding: true,
      lineDecorationsWidth: 12,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "gutter" as const,
      renderWhitespace: "selection" as const,
      smoothScrolling: true,
      cursorBlinking: "smooth" as const,
      cursorSmoothCaretAnimation: "on" as const,
      padding: { top: 12 },
      scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
    }),
    [],
  );

  const handleMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    decorationsRef.current = editor.createDecorationsCollection?.([]) ?? null;
    const layout = () => {
      if (editor.getDomNode()) editor.layout();
    };
    layout();
    window.requestAnimationFrame(layout);
    window.requestAnimationFrame(() => window.requestAnimationFrame(layout));
    setMountTick((n) => n + 1);
  }, []);

  // Agent-editing decorations + caret driver.
  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const collection = decorationsRef.current;
    if (!editor || !monaco || !collection) return;

    const clearAll = () => {
      collection.set([]);
      const caret = caretWidgetRef.current;
      if (caret) {
        editor.removeContentWidget?.(caret.widget as never);
        caretWidgetRef.current = null;
      }
    };

    if (!agentEditing) {
      clearAll();
      return;
    }

    const model = editor.getModel?.();
    const lineCount: number = model?.getLineCount?.() ?? file.content.split("\n").length;
    if (lineCount <= 0) {
      clearAll();
      return;
    }

    // Ensure a caret content widget exists.
    if (!caretWidgetRef.current) {
      const node = document.createElement("span");
      node.className = `monaco-agent-caret ${
        reducedMotion ? "" : "motion-caret-blink"
      }`.trim();
      const position = { lineNumber: 1, column: 1 };
      const widget = {
        getId: () => "agent.editing.caret",
        getDomNode: () => node,
        getPosition: () => ({
          position,
          preference: [
            monaco.editor.ContentWidgetPositionPreference.EXACT,
          ],
        }),
      };
      editor.addContentWidget?.(widget as never);
      caretWidgetRef.current = { node, widget, position };
    }

    const WINDOW = 3;
    const applyAt = (caretLine: number) => {
      const start = Math.max(1, caretLine - WINDOW + 1);
      const decos: unknown[] = [];
      for (let ln = start; ln <= caretLine; ln++) {
        decos.push({
          range: new monaco.Range(ln, 1, ln, 1),
          options: {
            isWholeLine: true,
            className: "agent-edit-line",
            linesDecorationsClassName: "agent-edit-line-margin",
            glyphMarginClassName: ln === caretLine ? "agent-edit-glyph" : undefined,
          },
        });
      }
      collection.set(decos as never);

      const caret = caretWidgetRef.current;
      if (caret) {
        const col = (model?.getLineMaxColumn?.(caretLine) as number) ?? 1;
        caret.position.lineNumber = caretLine;
        caret.position.column = col;
        editor.layoutContentWidget?.(caret.widget as never);
        if (!reducedMotion) editor.revealLineInCenterIfOutsideViewport?.(caretLine);
      }
    };

    if (reducedMotion) {
      // Static: a single highlighted line + non-blinking caret, no advancing.
      applyAt(Math.min(lineCount, 1));
      return;
    }

    let caretLine = 1;
    applyAt(caretLine);
    const timer = window.setInterval(() => {
      caretLine = caretLine >= lineCount ? 1 : caretLine + 1;
      applyAt(caretLine);
    }, 900);

    return () => {
      window.clearInterval(timer);
      clearAll();
    };
  }, [agentEditing, reducedMotion, file.path, file.content, mountTick]);

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-1 overflow-hidden bg-[#1e1e1e]">
      <EditorLoadBoundary file={file}>
        <Suspense fallback={<EditorFallback file={file} />}>
          <Editor
            className="h-full min-h-0 w-full min-w-0"
            wrapperProps={{
              className: "h-full min-h-0 w-full min-w-0 overflow-hidden",
            }}
            height="100%"
            width="100%"
            theme="vs-dark"
            language={file.language}
            path={file.path}
            value={file.content}
            onChange={(v) => update(file.path, v ?? "")}
            onMount={handleMount}
            options={editorOptions}
            loading={<EditorFallback file={file} />}
          />
        </Suspense>
      </EditorLoadBoundary>
    </div>
  );
}

type EditorLoadBoundaryProps = {
  children: ReactNode;
  file: OpenFile;
};

class EditorLoadBoundary extends Component<EditorLoadBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    console.warn("Monaco editor failed to load; using code preview fallback.", error, errorInfo);
  }

  componentDidUpdate(prevProps: EditorLoadBoundaryProps) {
    if (this.state.hasError && prevProps.file.path !== this.props.file.path) {
      this.setState({ hasError: false });
    }
  }

  render() {
    if (this.state.hasError) {
      return <EditorFallback file={this.props.file} />;
    }
    return this.props.children;
  }
}

function EditorFallback({ file }: { file: OpenFile }) {
  const lines = file.content.split("\n");

  return (
    <div
      data-testid="editor-fallback"
      className="h-full w-full min-w-full overflow-auto bg-[#1e1e1e] font-mono text-[12.5px] leading-relaxed text-[#d4d4d4]"
    >
      <div className="min-w-max py-3">
        {lines.map((line, index) => (
          <div
            key={`${file.path}-${index}`}
            className="grid min-h-[1.5rem] grid-cols-[3.5rem_minmax(0,1fr)]"
          >
            <span className="select-none border-r border-[#2a2a2a] pr-3 text-right text-[#858585]">
              {index + 1}
            </span>
            <code className="whitespace-pre px-4 text-[#d4d4d4]">
              {highlightLine(line, file.language)}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

const KEYWORDS = new Set([
  "async",
  "await",
  "catch",
  "class",
  "const",
  "else",
  "export",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "interface",
  "let",
  "new",
  "null",
  "return",
  "throw",
  "true",
  "try",
  "type",
  "var",
  "while",
]);
const HASH_COMMENT_LANGUAGES = new Set(["bash", "python", "shell", "sh", "yaml", "yml"]);
const TOKEN_RE =
  /(\/\/.*$|#.*$|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:])/g;

function highlightLine(line: string, language: string) {
  const normalized = language.toLowerCase();
  const tokens = line.split(TOKEN_RE).filter(Boolean);

  if (tokens.length === 0) return null;

  return tokens.map((token, index) => (
    <span key={`${index}-${token}`} className={tokenClassName(token, normalized)}>
      {token}
    </span>
  ));
}

function tokenClassName(token: string, language: string) {
  if (token.startsWith("//") || (token.startsWith("#") && HASH_COMMENT_LANGUAGES.has(language))) {
    return "text-[#6a9955]";
  }
  if (/^["'`]/.test(token)) {
    return "text-[#ce9178]";
  }
  if (/^\d/.test(token)) {
    return "text-[#b5cea8]";
  }
  if (KEYWORDS.has(token)) {
    return "text-[#569cd6]";
  }
  if (/^[{}()[\].,;:]$/.test(token)) {
    return "text-[#808080]";
  }
  if (/^[A-Z][A-Za-z0-9_$]*$/.test(token)) {
    return "text-[#4ec9b0]";
  }
  return "";
}
