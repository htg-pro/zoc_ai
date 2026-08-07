/**
 * The assistant's answer — zoc-agent-chat-rebuild R8.1, R8.5, R8.6, R17.1, task 15.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 15.2 (R8.1, R8.5, R8.6, R17.1).
 *
 * Unboxed prose at the answer type scale, the same message tier as `UserTurnRow`, with two
 * differences: the body goes through markdown, and there is no `You` label — the transcript's
 * default voice is the assistant's, so labelling it would label every row.
 *
 * The component is deliberately thin. Every decision worth making about assistant text —
 * `skipHtml`, the link and image policy, when a fence may be highlighted, the streaming
 * repair — lives in `MarkdownBody` and the modules beneath it, so this file is the *tier*
 * (spacing, colour, type scale) and nothing else. A safety rule added here rather than there
 * would be a second policy, applying to whichever rows happened to use this component.
 */
import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Citation, VisitedSource } from "@zoc-studio/shared-types";
import type { HighlightOptions } from "./markdown/highlight";
import { MarkdownBody } from "./markdown/MarkdownBody";
import { StreamingCaret } from "./StreamingCaret";
import { annotateCitationLinks, resolveCitations } from "./citation-resolution";

export interface AnswerRowProps {
  text: string;
  /**
   * True while the answer is still arriving.
   *
   * Threaded through rather than inferred, because the two things that depend on it — the
   * markdown repair and withholding fence highlighting — both need the *Run's* state, and a
   * component cannot tell a settled message from one whose next delta has not arrived yet.
   */
  streaming?: boolean;
  highlightOptions?: HighlightOptions;
  citations?: readonly Citation[];
  sources?: readonly VisitedSource[];
  className?: string;
}

export function AnswerRow({
  text,
  streaming = false,
  highlightOptions,
  citations = [],
  sources = [],
  className,
}: AnswerRowProps) {
  const resolved = useMemo(
    () => resolveCitations(text, citations, sources),
    [text, citations, sources],
  );
  const annotatedText = useMemo(
    () => annotateCitationLinks(text, resolved.inline),
    [text, resolved.inline],
  );

  return (
    // A plain block rather than a flex column: the caret is a second child, and a flex item would be
    // stacked below the prose instead of following it. With one child the two were equivalent.
    <div
      className={cn(className)}
      data-zoc-row="answer"
      data-streaming={streaming ? "" : undefined}
    >
      <MarkdownBody
        text={annotatedText}
        streaming={streaming}
        {...(highlightOptions === undefined ? {} : { highlightOptions })}
      />
      {resolved.trailing.length === 0 ? null : (
        <sup className="ml-1 inline-flex items-start gap-0.5" data-zoc-trailing-citations="">
          {resolved.trailing.map((link, index) => (
            <a
              key={`${link.citation.sourceId}:${String(index)}`}
              href={link.source.url}
              target="_blank"
              rel="noopener noreferrer nofollow"
              aria-label={`Citation: ${link.source.title ?? link.source.url}`}
              title={link.source.title ?? link.source.url}
              style={{ color: "var(--zoc-agent)" }}
            >
              <ExternalLink aria-hidden className="size-2.5" />
            </a>
          ))}
        </sup>
      )}
      {/*
        The open-text-part indicator (R19.1's `caret-blink`, task 23.1). Rendered only while the
        answer is still arriving, so a settled transcript animates nothing — which is what keeps
        R19.5's concurrency arithmetic honest on a long Session.
      */}
      {streaming ? <StreamingCaret /> : null}
    </div>
  );
}
