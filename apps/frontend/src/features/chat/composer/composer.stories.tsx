/**
 * The composer and its control row — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * The composer's own tests can assert that a refusal reaches `SendControl`; what they cannot judge is
 * whether the refusal reads as *fixable*. Three of this surface's states are refusals that differ only in
 * that — `disabled` (nothing the user can do here), `sendBlockedReason` (add a key), and the mode gate
 * (switch mode) — and R13.3 turns on a user telling them apart. `ComposerStates` puts them side by side.
 *
 * `AttachmentTray` has no story: it renders `<div class="contents" aria-hidden>` and nothing else until
 * 33.x, so a story of it would be an empty box captioned "empty".
 *
 * One caveat for anyone driving these by keyboard: every mounted `Composer` calls `registerChatKeyboard`,
 * and the registry holds one target, so `⌘↵` outside a textarea belongs to whichever variant mounted last.
 * Click into a composer first.
 */
import { useState } from "react";
import type { Story } from "@ladle/react";

import type { ConversationMode } from "@zoc-studio/shared-types";
import { StoryFrame, Variant } from "../story-frame";
import {
  CANDIDATES,
  CENSUS,
  CENSUS_NEAR_LIMIT,
  MENTIONS,
  MENTION_RESULTS,
  MODEL,
} from "../story-fixtures";
import type { Effort } from "../store";
import { Composer } from "./Composer";
import { ComposerInput } from "./ComposerInput";
import { ContextMeter } from "./ContextMeter";
import { ConversationModeControl } from "./ConversationModeControl";
import { EffortControl } from "./EffortControl";
import { MentionChips } from "./MentionChips";
import { MentionPopover } from "./MentionPopover";
import { ModeConsequenceLine } from "./ModeConsequenceLine";
import { SendControl } from "./SendControl";
import type { PermissionMode } from "./mode-consequence";

export default { title: "Chat / Composer" };

const WORKSPACE = "/home/dev/zoc-studio";
const MODES: readonly ConversationMode[] = ["ask", "plan", "agent"];
const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto", "deny"];

const COMPOSER_BASE = {
  candidates: CANDIDATES,
  model: MODEL,
  census: CENSUS,
  permissionMode: "ask" as PermissionMode,
  workspaceRoot: WORKSPACE,
  onSubmit: () => undefined,
} as const;

/**
 * The whole composer in each state a host can put it in.
 *
 * `streaming` and `disabled` are the pair worth looking at together: R8.7 keeps the textarea live through
 * a Run and R1.4 is the only thing that takes it away, so if these two look alike the composer is telling
 * a streaming user their draft is unwelcome.
 */
export const ComposerStates: Story = () => (
  <StoryFrame brief="Four refusals and one clear field. Each refusal should say what would clear it — or, for the read-only viewer, that nothing here will.">
    <Variant label="idle" width={720}>
      <Composer {...COMPOSER_BASE} streaming={false} />
    </Variant>
    <Variant
      label="streaming"
      note="R8.7: the field stays live and a second message queues rather than being refused."
      width={720}
    >
      <Composer
        {...COMPOSER_BASE}
        streaming
        queued={1}
        runState="running"
        onCancelRun={() => undefined}
      />
    </Variant>
    <Variant
      label="send blocked"
      note="R13.3's keyless cloud model. The field is deliberately still editable — the fix is a key, not a shorter prompt."
      width={720}
    >
      <Composer
        {...COMPOSER_BASE}
        streaming={false}
        sendBlockedReason="Add an OpenAI key to run GPT-5.2."
      />
    </Variant>
    <Variant
      label="read-only viewer"
      note="R1.4: the one state that does take the field away."
      width={720}
    >
      <Composer {...COMPOSER_BASE} streaming={false} disabled />
    </Variant>
    <Variant
      label="near the context limit"
      note="Same composer, a census at 93 % with a summary active. Only the meter should change."
      width={720}
    >
      <Composer
        {...COMPOSER_BASE}
        census={CENSUS_NEAR_LIMIT}
        streaming={false}
        onCompact={() => undefined}
      />
    </Variant>
  </StoryFrame>
);

/** Mode and Effort, live, plus every consequence sentence the two axes produce. */
export const Controls: Story = () => {
  const [mode, setMode] = useState<ConversationMode>("agent");
  const [effort, setEffort] = useState<Effort>("balanced");
  return (
    <StoryFrame brief="Mode is a claim about what the agent may do; Effort is a dial. The two must not look equally consequential.">
      <Variant label="mode and effort" note={`Selected: ${mode} / ${effort}.`}>
        <div className="flex items-center gap-2">
          <ConversationModeControl value={mode} onChange={setMode} />
          <EffortControl value={effort} onChange={setEffort} />
        </div>
      </Variant>
      <Variant
        label="consequence lines — 3 modes × 3 permission modes"
        note="R11.1's two axes. A cell that reads the same as its neighbour means one axis is not landing."
      >
        <div className="flex flex-col gap-3">
          {MODES.map((m) => (
            <div key={m} className="flex flex-col gap-1">
              {PERMISSION_MODES.map((permissionMode) => (
                <div key={permissionMode} className="flex items-baseline gap-3">
                  <code
                    className="w-24 shrink-0 font-mono"
                    style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
                  >
                    {m}/{permissionMode}
                  </code>
                  <ModeConsequenceLine mode={m} permissionMode={permissionMode} />
                </div>
              ))}
            </div>
          ))}
        </div>
      </Variant>
    </StoryFrame>
  );
};

/**
 * `SendControl` alone, which is where a refusal's *sentence* is judged.
 *
 * The silent refusal is the one to look hardest at: `enabled: false` with `reason: null` is an empty
 * draft, and it must not look like a failure — the user has simply not typed yet.
 */
export const Send: Story = () => (
  <StoryFrame brief="Five states. Only two of them are things going wrong; the other three are ordinary.">
    <Variant label="ready">
      <SendControl streaming={false} enabled reason={null} queued={0} onSend={() => undefined} />
    </Variant>
    <Variant label="empty draft" note="Refused with no sentence: nothing has gone wrong yet.">
      <SendControl
        streaming={false}
        enabled={false}
        reason={null}
        queued={0}
        onSend={() => undefined}
      />
    </Variant>
    <Variant label="gated" note="A stated refusal the user can clear.">
      <SendControl
        streaming={false}
        enabled={false}
        reason="Ask mode cannot write files. Switch to Agent to send this."
        queued={0}
        onSend={() => undefined}
      />
    </Variant>
    <Variant label="streaming">
      <SendControl streaming enabled reason={null} queued={0} onSend={() => undefined} />
    </Variant>
    <Variant
      label="streaming, one queued"
      note="At most one: the control says so rather than counting up."
    >
      <SendControl streaming enabled reason={null} queued={1} onSend={() => undefined} />
    </Variant>
  </StoryFrame>
);

/** The meter across the range, since its bands are the whole component. */
export const Meter: Story = () => (
  <StoryFrame brief="A third of the window, then 93 % with a summary active. The second must read as a warning without reading as an error.">
    <Variant label="comfortable" width={420}>
      <ContextMeter
        model={MODEL}
        census={CENSUS}
        mentions={[]}
        onRemoveMentions={() => undefined}
      />
    </Variant>
    <Variant
      label="near the limit"
      note="R34.4's Compact is offered only when a host passes `onCompact`."
      width={420}
    >
      <ContextMeter
        model={MODEL}
        census={CENSUS_NEAR_LIMIT}
        mentions={[]}
        onRemoveMentions={() => undefined}
        onCompact={() => undefined}
      />
    </Variant>
    <Variant
      label="with attachments"
      note="Mention tokens are counted, and the overflow dialog is how they are dropped."
      width={420}
    >
      <ContextMeter
        model={MODEL}
        census={CENSUS_NEAR_LIMIT}
        mentions={MENTIONS}
        onRemoveMentions={() => undefined}
        onCompact={() => undefined}
      />
    </Variant>
  </StoryFrame>
);

/**
 * The mention surface: chips for what is attached, the popover for what could be.
 *
 * The popover is rendered `open` against a static anchor rather than typed into, so the highlight and the
 * two categories are inspectable without a caret. `Mentions` in `ComposerStates` is the live path — type
 * `@` there.
 */
export const Mentions: Story = () => {
  const [selected, setSelected] = useState(0);
  return (
    <StoryFrame brief="An unresolved chip (third) must be tellable from a resolved one: it contributes no tokens and will not be sent.">
      <Variant label="chips" width={520}>
        <MentionChips mentions={MENTIONS} onRemove={() => undefined} />
      </Variant>
      <Variant
        label="popover — open"
        note={`Highlighted row ${String(selected)}. Hovering a row moves it, so Enter inserts what looks chosen.`}
        width={520}
      >
        <MentionPopover
          open
          results={MENTION_RESULTS}
          selected={selected}
          onSelect={() => undefined}
          onHighlight={setSelected}
          onOpenChange={() => undefined}
        >
          <div
            className="rounded-[var(--zoc-radius-input)] border border-[var(--zoc-border)] p-3 font-mono"
            style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-body)" }}
          >
            Guard the empty row list in @
          </div>
        </MentionPopover>
      </Variant>
      <Variant
        label="popover — no matches"
        note="An open popover with nothing in it, which is what a typo produces."
        width={520}
      >
        <MentionPopover
          open
          results={[]}
          selected={0}
          onSelect={() => undefined}
          onHighlight={() => undefined}
          onOpenChange={() => undefined}
        >
          <div
            className="rounded-[var(--zoc-radius-input)] border border-[var(--zoc-border)] p-3 font-mono"
            style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-body)" }}
          >
            Guard the empty row list in @qqq
          </div>
        </MentionPopover>
      </Variant>
    </StoryFrame>
  );
};

/** The textarea by itself: placeholder, typed, and the read-only form. */
export const Input: Story = () => {
  const [text, setText] = useState("Guard the empty row list in the transcript factory.");
  return (
    <StoryFrame brief="It grows with its content up to a cap, then scrolls. The cap is what keeps the transcript visible while a long prompt is written.">
      <Variant label="empty" width={620}>
        <ComposerInput
          value=""
          onChange={() => undefined}
          onSubmit={() => undefined}
          onEscape={() => undefined}
        />
      </Variant>
      <Variant label="typed" width={620}>
        <ComposerInput
          value={text}
          onChange={(next) => {
            setText(next.text);
          }}
          onSubmit={() => undefined}
          onEscape={() => undefined}
        />
      </Variant>
      <Variant
        label="read-only"
        note="R1.4 again, at the level the attribute actually lands."
        width={620}
      >
        <ComposerInput
          value="A prompt from a Session opened for reading."
          onChange={() => undefined}
          onSubmit={() => undefined}
          onEscape={() => undefined}
          disabled
        />
      </Variant>
    </StoryFrame>
  );
};
