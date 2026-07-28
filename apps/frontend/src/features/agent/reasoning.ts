/**
 * reasoning.ts — separate a model's private reasoning from the answer it gives.
 *
 * Local models are asked to wrap their scratchpad in `<think>…</think>` (see
 * `THINKING_SYSTEM_PROMPT` in the gateway's `run_pipeline.py`). Reasoning that
 * travels on the dedicated `thinking` event already has its own collapsible row.
 * The failure this module exists for is the *other* path: a model that emits its
 * scratchpad inline in the answer channel. There was no stripping layer anywhere
 * on the frontend, so that raw text was rendered as if it were the answer.
 *
 * Two shapes have to be handled, and the second is the one that matters while a
 * response is still streaming:
 *
 *   1. Closed:  `<think>weighing options</think>Here is the fix.`
 *   2. Dangling: `<think>weighing options`  — the close tag has not arrived yet,
 *      so everything after the opening tag is reasoning-so-far, not an answer.
 *
 * Treating a dangling block as an answer is what makes a chat window flash raw
 * reasoning and then replace it. Treating it as reasoning keeps the answer area
 * empty (the caller shows its streaming indicator) until real answer text
 * arrives.
 */

export interface SplitAnswer {
  /** The user-facing answer, with every reasoning block removed. */
  answer: string;
  /** The extracted reasoning, blocks joined by a blank line. May be empty. */
  reasoning: string;
}

// `[\s\S]` rather than the `s` flag: the target list in tsconfig does not
// guarantee `dotAll`.
const CLOSED_BLOCK = /<think>([\s\S]*?)<\/think>/gi;
const DANGLING_BLOCK = /<think>([\s\S]*)$/i;

/**
 * Split `text` into the answer and the model's reasoning.
 *
 * Pure and total: any string is accepted, and text with no reasoning is returned
 * unchanged as the answer. Only whitespace introduced by removing a block is
 * collapsed — the answer's own formatting (markdown, code fences, blank lines)
 * is preserved, because it is rendered as markdown downstream.
 */
export function splitReasoning(text: string): SplitAnswer {
  if (!text || !text.toLowerCase().includes("<think>")) {
    return { answer: text, reasoning: "" };
  }

  const blocks: string[] = [];
  let answer = text.replace(CLOSED_BLOCK, (_match, body: string) => {
    blocks.push(body.trim());
    return "";
  });

  const dangling = DANGLING_BLOCK.exec(answer);
  if (dangling) {
    blocks.push(dangling[1].trim());
    answer = answer.slice(0, dangling.index);
  }

  return {
    answer: answer.trim(),
    reasoning: blocks.filter(Boolean).join("\n\n"),
  };
}

/** The answer half of {@link splitReasoning}, for callers that discard reasoning. */
export function stripReasoning(text: string): string {
  return splitReasoning(text).answer;
}
