import type { JSX } from "react";
import {
  collapseCarriageReturns,
  parseTerminalOutput,
  type Annotation,
  type ParsedLine,
} from "./output-parser";

/**
 * Interactive overlay for terminal output (Part 6.2). Renders parsed
 * annotations as clickable affordances over the raw text without modifying it:
 * file paths open in the editor, URLs open externally, stacktrace lines offer
 * "Fix with Agent", test summaries render a pass/fail badge, and carriage-return
 * progress lines render a `<progress>` element. Handlers are injected so the
 * component is unit-testable without the store/Tauri.
 */
export interface OutputHandlers {
  onOpenPath: (path: string, line?: number, column?: number) => void;
  onOpenUrl: (url: string) => void;
  onFixWithAgent: (text: string) => void;
}

function renderAnnotation(a: Annotation, handlers: OutputHandlers, key: number): JSX.Element {
  if (a.type === "path") {
    return (
      <button
        key={key}
        type="button"
        data-annotation="path"
        className="text-[var(--zoc-info)] underline underline-offset-2 hover:opacity-80"
        onClick={() => handlers.onOpenPath(a.path, a.line, a.column)}
      >
        {a.raw}
      </button>
    );
  }
  return (
    <button
      key={key}
      type="button"
      data-annotation="url"
      className="text-[var(--zoc-info)] underline underline-offset-2 hover:opacity-80"
      onClick={() => handlers.onOpenUrl((a as { url: string }).url)}
    >
      {a.raw}
    </button>
  );
}

function AnnotatedLine({ line, handlers }: { line: ParsedLine; handlers: OutputHandlers }): JSX.Element {
  const { text, annotations } = line;

  if (text.includes("\r")) {
    const visible = collapseCarriageReturns(text);
    const match = visible.match(/(\d+)\s*%/);
    if (match) {
      return (
        <div data-annotation="progress" className="flex items-center gap-2">
          <progress value={Number(match[1])} max={100} className="h-1.5 w-40" />
          <span>{visible}</span>
        </div>
      );
    }
    return <div>{visible}</div>;
  }

  const stack = annotations.find((a) => a.type === "stack");
  if (stack) {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[var(--zoc-error)]">{text}</span>
        <button
          type="button"
          data-annotation="fix"
          className="shrink-0 rounded border border-[var(--zoc-ember)]/40 px-1.5 py-0.5 text-[10px] text-[var(--zoc-ember)]"
          onClick={() => handlers.onFixWithAgent(text)}
        >
          Fix with Agent
        </button>
      </div>
    );
  }

  const summary = annotations.find((a) => a.type === "test-summary");
  if (summary && summary.type === "test-summary") {
    const tone = summary.failed > 0 ? "text-[var(--zoc-error)]" : "text-[var(--zoc-success)]";
    return (
      <div className="flex items-center gap-2">
        <span>{text}</span>
        <span data-annotation="test-summary" className={`rounded px-1.5 py-0.5 text-[10px] ${tone}`}>
          {summary.passed} passed, {summary.failed} failed, {summary.skipped} skipped
        </span>
      </div>
    );
  }

  // Interleave plain text with clickable path/url annotations.
  const parts: JSX.Element[] = [];
  let cursor = 0;
  annotations.forEach((a, i) => {
    if (a.start > cursor) parts.push(<span key={`t${i}`}>{text.slice(cursor, a.start)}</span>);
    parts.push(renderAnnotation(a, handlers, i));
    cursor = a.end;
  });
  if (cursor < text.length) parts.push(<span key="tail">{text.slice(cursor)}</span>);
  return <div>{parts.length > 0 ? parts : text}</div>;
}

export function AnnotatedOutput({
  text,
  handlers,
}: {
  text: string;
  handlers: OutputHandlers;
}): JSX.Element {
  const lines = parseTerminalOutput(text);
  return (
    <div className="whitespace-pre-wrap font-mono text-xs leading-relaxed">
      {lines.map((line, i) => (
        <AnnotatedLine key={i} line={line} handlers={handlers} />
      ))}
    </div>
  );
}
