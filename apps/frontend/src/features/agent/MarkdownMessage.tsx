import { useState } from "react";
import { Check, ClipboardCopy, CornerDownLeft } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { useApp } from "@/lib/store";
import { insertAtCursor } from "@/lib/editor-actions";
import { cn } from "@/lib/utils";
import {
  headingLevel,
  headingText,
  normalizePathToken,
  splitInline,
  splitMarkdownBlocks,
  type InlineSpan,
} from "./markdown";

/**
 * Markdown renderer for assistant answers (§12.1).
 *
 * Renders headers, bold/italic, inline code, fenced code blocks, and clickable
 * workspace paths. Everything is composed from React elements — model output is
 * never injected as HTML.
 */
export function MarkdownMessage({ content }: { content: string }) {
  const blocks = splitMarkdownBlocks(content);
  return (
    <div className="space-y-2">
      {blocks.map((block, index) =>
        block.kind === "code" ? (
          <CodeBlock
            key={index}
            code={block.code}
            language={block.language}
            streaming={!block.closed}
          />
        ) : (
          <ProseBlock key={index} text={block.text} />
        ),
      )}
    </div>
  );
}

function ProseBlock({ text }: { text: string }) {
  return (
    <div className="space-y-1">
      {text.split("\n").map((line, index) => {
        const level = headingLevel(line);
        if (level > 0) {
          return (
            <div
              key={index}
              className={cn(
                "font-semibold text-[#EDEDF0]",
                level <= 2 ? "text-[14px]" : "text-[13px]",
              )}
            >
              {headingText(line)}
            </div>
          );
        }
        if (!line.trim()) return <div key={index} className="h-1" />;
        const bullet = /^\s*[-*+]\s+/.test(line);
        return (
          <div
            key={index}
            className={cn("text-[13px] leading-relaxed text-[#D4D4D8]", bullet && "pl-3")}
          >
            {bullet && <span className="mr-1 text-[#71717A]">•</span>}
            {splitInline(bullet ? line.replace(/^\s*[-*+]\s+/, "") : line).map((span, i) => (
              <InlineSpanView key={i} span={span} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function InlineSpanView({ span }: { span: InlineSpan }) {
  const openFile = useApp((s) => s.openFile);

  switch (span.kind) {
    case "code":
      return (
        <code className="rounded bg-[#1A1A20] px-1 py-0.5 font-mono text-[11.5px] text-[#C4B5FD]">
          {span.text}
        </code>
      );
    case "bold":
      return <strong className="font-semibold text-[#EDEDF0]">{span.text}</strong>;
    case "italic":
      return <em className="italic">{span.text}</em>;
    case "path":
      return (
        <button
          type="button"
          onClick={() => void openFile(normalizePathToken(span.text))}
          title={`Open ${normalizePathToken(span.text)}`}
          className="font-mono text-[11.5px] text-[#60a5fa] underline decoration-dotted hover:text-[#93c5fd]"
        >
          {span.text}
        </button>
      );
    default:
      return <>{span.text}</>;
  }
}

function CodeBlock({
  code,
  language,
  streaming,
}: {
  code: string;
  language: string | null;
  streaming: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy");
    }
  };

  const insert = () => {
    if (insertAtCursor(code)) toast.success("Inserted at cursor");
    else toast.error("Open a file in the editor first");
  };

  return (
    <div className="overflow-hidden rounded-lg border border-[#26262B] bg-[#0F0F14]">
      <div className="flex items-center gap-2 border-b border-[#1E1E23] px-2 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-[#52525B]">
          {language ?? "code"}
          {streaming && " · streaming"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[#A1A1AA] hover:bg-[#1E1E23] hover:text-[#EDEDF0]"
          >
            {copied ? <Check className="h-3 w-3" /> : <ClipboardCopy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={insert}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] text-[#A1A1AA] hover:bg-[#1E1E23] hover:text-[#EDEDF0]"
          >
            <CornerDownLeft className="h-3 w-3" />
            Insert at cursor
          </button>
        </div>
      </div>
      <pre className="max-h-96 overflow-auto p-2.5 font-mono text-[11.5px] leading-relaxed text-[#D4D4D8]">
        {code}
      </pre>
    </div>
  );
}
