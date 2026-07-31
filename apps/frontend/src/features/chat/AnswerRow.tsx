/**
 * The assistant's answer — zoc-agent-chat-rebuild R8.1, R8.5, R8.6, R17.1, task 15.2.
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
import { cn } from "@/lib/utils";
import type { HighlightOptions } from "./markdown/highlight";
import { MarkdownBody } from "./markdown/MarkdownBody";

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
  className?: string;
}

export function AnswerRow({
  text,
  streaming = false,
  highlightOptions,
  className,
}: AnswerRowProps) {
  return (
    <div
      className={cn("flex flex-col", className)}
      data-zoc-row="answer"
      data-streaming={streaming ? "" : undefined}
    >
      <MarkdownBody
        text={text}
        streaming={streaming}
        {...(highlightOptions === undefined ? {} : { highlightOptions })}
      />
    </div>
  );
}
