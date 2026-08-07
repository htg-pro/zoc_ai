/**
 * The markdown pipeline — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * `repair.ts` and `sanitize.ts` are both fully property-tested, and neither test can answer the question
 * this file exists for: whether the repaired output *reads* as prose while it is still arriving. R8.6's
 * repair closes an open fence so the half-written block renders as a block rather than as three lines of
 * backticks — and the failure mode it trades for is a block that flickers between shapes on every delta.
 * `Streaming` below is where that is judged, by dragging the slider.
 *
 * The `javascript:` link in `Prose` is deliberate and is not a repair case. `sanitize.ts` renders it inert,
 * and the story keeps it because "inert" has to be visible: a link that looks live and does nothing is a
 * worse outcome than one that never looked like a link.
 */
import { useState } from "react";
import type { Story } from "@ladle/react";

import { StoryFrame, Variant } from "../story-frame";
import { ANSWER_MARKDOWN } from "../story-fixtures";
import { CodeBlock } from "./CodeBlock";
import { MarkdownBody } from "./MarkdownBody";

export default { title: "Chat / Markdown" };

const CODE = [
  "export function rowsOfMessage(message: ZocUIMessage): readonly TranscriptRow[] {",
  "  const rows: TranscriptRow[] = [];",
  "  for (const part of message.parts) {",
  "    // Eight consecutive tool parts become one timeline row, not eight.",
  "    if (part.type === 'dynamic-tool') { appendTool(rows, part); continue; }",
  "  }",
  "  return rows.length === 0 ? EMPTY_ROWS : rows;",
  "}",
].join("\n");

/** Everything the renderer supports, so an unstyled element is visible rather than discovered in a Run. */
const PROSE = [
  "## What changed",
  "",
  "The factory returns the shared empty array, so a message with no renderable part is **one identity**",
  "rather than a fresh `[]` per render. See [the transcript model](https://example.com/transcript) and",
  "[this inert link](javascript:alert(1)) — the second one is sanitised and must not look pressable.",
  "",
  "1. Guard before the loop",
  "2. Skip measurement for a list that will never draw",
  "   - the virtualiser keeps its cache",
  "   - the row height is never asked for",
  "",
  "> A message with no renderable part still has metadata, which is why the row list is empty rather",
  "> than the message being dropped.",
  "",
  "| Part | Rows |",
  "| --- | --- |",
  "| `text` | 1 |",
  "| eight `dynamic-tool` | 1 |",
  "",
  "```ts",
  "if (rows.length === 0) return EMPTY_ROWS;",
  "```",
  "",
  "---",
  "",
  "*Verified by* `pnpm --filter @zoc-studio/frontend test transcript`.",
].join("\n");

/** The four repairs, each shown as the text a stream would actually be paused mid-way through. */
const UNREPAIRED: readonly { readonly label: string; readonly text: string }[] = [
  {
    label: "unclosed fence",
    text: "Applying the guard:\n\n```ts\nif (rows.length === 0) return EMP",
  },
  { label: "unclosed inline code", text: "The factory returns `EMPTY_RO" },
  { label: "unclosed emphasis", text: "This is **one identity rather than" },
  { label: "dangling link", text: "See [the transcript model](https://exam" },
];

export const Prose: Story = () => (
  <StoryFrame brief="Every supported element in one body. A heading, a table cell, or a rule that looks unstyled is a gap.">
    <Variant label="settled" width={720}>
      <MarkdownBody text={PROSE} />
    </Variant>
    <Variant
      label="the answer fixture"
      note="What the transcript stories render, on its own for comparison."
      width={720}
    >
      <MarkdownBody text={ANSWER_MARKDOWN} />
    </Variant>
    <Variant
      label="empty"
      note="Before the first delta. The body renders nothing rather than a placeholder."
      width={720}
    >
      <MarkdownBody text="" streaming />
    </Variant>
  </StoryFrame>
);

/**
 * The repair, at every prefix of a real answer.
 *
 * A slider rather than fixed variants: R8.6's actual requirement is that the body does not *thrash* as
 * text arrives, and thrashing is only visible in motion. Drag it and watch the code block — it should
 * appear once and grow, never appear, vanish, and reappear.
 */
export const Streaming: Story = () => {
  const [cut, setCut] = useState(Math.round(ANSWER_MARKDOWN.length * 0.55));
  return (
    <StoryFrame brief="Drag the slider from 0 to the end. Blocks may grow; they may not flicker between shapes.">
      <Variant
        label={`prefix — ${String(cut)} / ${String(ANSWER_MARKDOWN.length)} chars`}
        width={720}
      >
        <div className="flex flex-col gap-3">
          <input
            type="range"
            min={0}
            max={ANSWER_MARKDOWN.length}
            value={cut}
            aria-label="Characters received"
            onChange={(event) => {
              setCut(Number(event.target.value));
            }}
          />
          <MarkdownBody text={ANSWER_MARKDOWN.slice(0, cut)} streaming />
        </div>
      </Variant>
      {UNREPAIRED.map((item) => (
        <Variant key={item.label} label={item.label} note={JSON.stringify(item.text)} width={720}>
          <MarkdownBody text={item.text} streaming />
        </Variant>
      ))}
    </StoryFrame>
  );
};

/**
 * The code block's two states, which differ only in whether highlighting has been allowed to run.
 *
 * Both must be readable. The open one is what a user looks at for most of a long block's life, and if it
 * reads as unstyled-and-broken rather than plain-and-arriving then withholding the highlighter — which is
 * what keeps a streaming Run off the tokeniser — has cost more than it saved.
 */
export const Code: Story = () => (
  <StoryFrame brief="Closed against open. The open block is plain text on purpose; check that plain still reads as code.">
    <Variant label="closed" note="Highlighting has run." width={720}>
      <CodeBlock code={CODE} language="typescript" closed />
    </Variant>
    <Variant
      label="open"
      note="Still arriving: no highlighting, by design (one tokenise per fence, not per delta)."
      width={720}
    >
      <CodeBlock code={CODE.slice(0, 220)} language="typescript" />
    </Variant>
    <Variant
      label="untagged fence"
      note="No info string. The copy control and the frame are all it gets."
      width={720}
    >
      <CodeBlock code={"pnpm --filter @zoc-studio/frontend test transcript"} closed />
    </Variant>
    <Variant
      label="a long line"
      note="Wider than the column: it must scroll the block rather than the transcript."
      width={720}
    >
      <CodeBlock
        code={`const selection = applicableHunks(plan, decisions, onDisk).hunkIds.filter((id) => decisions[plan.planId]?.[path]?.[id] === "accepted");`}
        language="typescript"
        closed
      />
    </Variant>
  </StoryFrame>
);
