/**
 * The transcript's rows — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * The three-tier hierarchy is the thing these stories exist to check, and it is the one thing the
 * renderer suite cannot: `chat-panel.test.tsx` can assert that a reasoning row is muted and an answer
 * row is not, but "does the answer read as the answer" is a look. R17.5 makes that look a story
 * rather than a guess.
 *
 * Every fixture comes from `story-fixtures.ts`, which is the point of that module — three rows that
 * each invented their own prose would make every difference on screen ambiguous, since a row looks
 * heavier both when its tier is louder and when someone typed a longer sentence into it.
 *
 * The last three stories mount the real {@link Transcript}, virtualiser and streaming tail included.
 * `EveryRowKind` above them renders the same rows through {@link TranscriptRowView} instead, and both
 * are here on purpose: the row-level story is where a tier is judged, and the transcript-level one is
 * where the *spacing between* tiers is — which only exists once the rows are in one scroll container.
 */
import type { ReactNode } from "react";
import type { Story } from "@ladle/react";

import { AnswerRow } from "./AnswerRow";
import { CompactionRow } from "./CompactionRow";
import { ErrorRow } from "./ErrorRow";
import { HistoricalRow } from "./HistoricalRow";
import { ReasoningRow } from "./ReasoningRow";
import { Transcript } from "./Transcript";
import { TranscriptRowView } from "./TranscriptRowView";
import { UnknownPartRow } from "./UnknownPartRow";
import { UsageRow } from "./UsageRow";
import { UserTurnRow } from "./UserTurnRow";
import {
  ANSWER_MARKDOWN,
  COMPACTION,
  ERROR_RETRYABLE,
  ERROR_TERMINAL,
  EVERY_ROW,
  FOLDED_TURNS,
  HISTORICAL,
  HISTORICAL_ROWS,
  MESSAGES,
  REASONING_TEXT,
  RUN_INTERRUPTED,
  STREAMING_MESSAGES,
  USAGE,
  USER_PROMPT,
} from "./story-fixtures";
import { StoryFrame, Variant } from "./story-frame";

export default { title: "Chat / Transcript" };

const resolveFoldedTurn = (messageId: string) => FOLDED_TURNS.get(messageId);

/** A bounded column: the transcript virtualises against its container's height, not the page's. */
function Viewport({ children }: { children: ReactNode }) {
  return <div className="flex h-[520px] flex-col">{children}</div>;
}

/**
 * The R17.5 judgement, with nothing else on screen: prompt, thinking, answer.
 *
 * Undivided by `Variant` boxes deliberately — the three tiers are meant to be told apart by their own
 * treatment, and a labelled border around each would supply the separation the design has to earn.
 */
export const ThreeTierHierarchy: Story = () => (
  <StoryFrame brief="The gate: the answer must read as the answer, the reasoning as an aside, and the prompt as neither — with no borders helping.">
    <div className="flex flex-col gap-2">
      <UserTurnRow text={USER_PROMPT} />
      <ReasoningRow text={REASONING_TEXT} terminal elapsedMs={4_200} />
      <AnswerRow text={ANSWER_MARKDOWN} />
    </div>
  </StoryFrame>
);

export const MessageRows: Story = () => (
  <StoryFrame brief="The two message tiers, settled and mid-stream.">
    <Variant label="user turn">
      <UserTurnRow text={USER_PROMPT} />
    </Variant>
    <Variant label="answer — settled">
      <AnswerRow text={ANSWER_MARKDOWN} />
    </Variant>
    <Variant
      label="answer — streaming"
      note="An unclosed fence, repaired for display. The caret sits at the end of the last block."
    >
      <AnswerRow
        text={"Applying the guard now:\n\n```ts\nif (rows.length === 0) return EMP"}
        streaming
      />
    </Variant>
    <Variant label="answer — empty" note="Before the first delta: the row exists and says nothing.">
      <AnswerRow text="" streaming />
    </Variant>
  </StoryFrame>
);

/**
 * R8.3 and R8.4's four states.
 *
 * `terminal` is not `!streaming`: reasoning finishes while the Run carries on into tool calls, and the
 * collapse is keyed on the **Run** ending. The middle two variants are what make that visible — same
 * text, same `streaming={false}`, and only one of them folded.
 */
export const ReasoningStates: Story = () => (
  <StoryFrame brief="Streaming, settled mid-Run, collapsed at the Run's end, and redacted.">
    <Variant label="streaming">
      <ReasoningRow text={REASONING_TEXT.slice(0, 96)} streaming />
    </Variant>
    <Variant label="settled — Run still going" note="terminal={false}: the region stays open.">
      <ReasoningRow text={REASONING_TEXT} elapsedMs={4_200} />
    </Variant>
    <Variant label="settled — Run terminal" note="terminal: R8.4 folds it, keeping the duration.">
      <ReasoningRow text={REASONING_TEXT} terminal elapsedMs={4_200} />
    </Variant>
    <Variant label="redacted" note="The provider reported reasoning it will not return.">
      <ReasoningRow text="" terminal redacted elapsedMs={2_100} />
    </Variant>
  </StoryFrame>
);

export const SystemRows: Story = () => (
  <StoryFrame brief="The rows that are neither message nor decision: they must recede without becoming unreadable.">
    <Variant label="usage">
      <UsageRow usage={USAGE} model="claude-opus-5" />
    </Variant>
    <Variant
      label="compaction"
      note="Folded ids resolved to turn labels through the resolver (R34.3)."
    >
      <CompactionRow compaction={COMPACTION} resolveFoldedTurn={resolveFoldedTurn} />
    </Variant>
    {HISTORICAL.map((item) => (
      <Variant
        key={item.kind === "event" ? item.event.id : item.runId}
        label={`historical — ${item.kind}`}
        note={
          item.kind === "stage-run"
            ? "Consecutive same-Run stage events, collapsed (R23.2)."
            : undefined
        }
      >
        <HistoricalRow item={item} />
      </Variant>
    ))}
    <Variant
      label="unknown part"
      note="A discriminant newer than this renderer. R7.6: neutral, and the stream carries on."
    >
      <UnknownPartRow discriminant="data-zoc-telemetry" />
    </Variant>
  </StoryFrame>
);

/**
 * The three error shapes, which differ by which control they offer rather than by their look.
 *
 * `ErrorRow` takes `unknown` and normalises, so the interrupted variant is a `RunLifecyclePart` and not
 * an `ErrorPart` — that is the only source of R16.5's `Continue`, and a story with the part form alone
 * would show two of the three controls that exist.
 */
export const ErrorRows: Story = () => (
  <StoryFrame brief="Retryable, permanent, and interrupted. Judge whether the control offered matches what the sentence says went wrong.">
    <Variant label="retryable" note="R16.6 offers Retry.">
      <ErrorRow error={ERROR_RETRYABLE} onRetry={() => undefined} />
    </Variant>
    <Variant label="permanent" note="No control: nothing the user presses can change the outcome.">
      <ErrorRow error={ERROR_TERMINAL} />
    </Variant>
    <Variant label="interrupted" note="R16.5 offers Continue, from the partial transcript.">
      <ErrorRow error={RUN_INTERRUPTED} onContinue={() => undefined} />
    </Variant>
  </StoryFrame>
);

/**
 * One row of every `TranscriptRow` kind, through the real row slot.
 *
 * All thirteen, including `sources` — which draws nothing until 36.4 builds its row. It is in the list
 * rather than omitted because `ROWS_AWAITING_A_RENDERER` names it as a known gap, and the one place
 * that gap should be visible is the story whose job is showing every kind.
 */
export const EveryRowKind: Story = () => (
  <StoryFrame brief="Thirteen kinds in transcript order. The gap between two rows should say which tier each belongs to.">
    <div className="flex flex-col gap-2">
      {EVERY_ROW.map((row) => (
        <TranscriptRowView key={row.id} row={row} resolveFoldedTurn={resolveFoldedTurn} />
      ))}
    </div>
  </StoryFrame>
);

/**
 * 27.1's required story: the real transcript, one row of every kind, in sequence.
 *
 * The rows come out of `rowsOfMessage` rather than from `EVERY_ROW`, so this is also the check that the
 * factory produces what the row-level story shows — including the two orderings only it decides: eight
 * consecutive tool parts becoming one timeline, and the unknown-discriminant placeholder landing after
 * that timeline rather than splitting it in half.
 *
 * `historicalRows` is a separate prop because nothing the runtime emits is historical; the migration
 * reader is what produces them.
 */
export const TranscriptEveryKind: Story = () => (
  <StoryFrame brief="The virtualiser, the row cache, and the streaming tail, over a two-turn Session that carries every part.">
    <Viewport>
      <Transcript
        messages={MESSAGES}
        streaming={false}
        historicalRows={HISTORICAL_ROWS}
        runState="completed"
        resolveFoldedTurn={resolveFoldedTurn}
        onErrorRetry={() => undefined}
        onToolRetry={() => undefined}
      />
    </Viewport>
  </StoryFrame>
);

/** Mid-Run: the tail is outside the virtualiser, so the caret and the repair are live here. */
export const TranscriptStreaming: Story = () => (
  <StoryFrame brief="An answer still arriving behind an unclosed fence. The tail row must not jump as it grows (R20.7).">
    <Viewport>
      <Transcript messages={STREAMING_MESSAGES} streaming runState="running" />
    </Viewport>
  </StoryFrame>
);

/** No messages at all — the transcript's own empty state, which is not `EmptyState`'s. */
export const TranscriptEmpty: Story = () => (
  <StoryFrame brief="A Session with no turns. The transcript draws nothing; the panel is what offers the onboarding surface.">
    <Viewport>
      <Transcript messages={[]} streaming={false} />
    </Viewport>
  </StoryFrame>
);
