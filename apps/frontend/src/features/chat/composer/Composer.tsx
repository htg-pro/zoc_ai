/**
 * The composer — zoc-agent-chat-rebuild R8.7, R11.10, R12.1–R12.7, R32.1, R32.2, R32.13–R32.15,
 * task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R8.7, R11.10, R12.1, R12.7, R32.1, R32.2).
 *
 * The assembly. Everything it owns is wiring: the store's draft and mentions, the mention search and its
 * debounce, the popover's open state and selection, the pre-submission gate, and the two performance
 * marks. Every decision it makes is delegated — the parser, the index, the gate, the consequence sentence,
 * and the context figures are all modules beside it, which is what lets ten properties assert against them
 * without mounting this component.
 *
 * ## What it does not own
 *
 * **The queue.** `Queue` calls `onSubmit` like `Send` does; the panel holds the message and sends it when
 * the Run settles, and reports the count back through `queued`. The composer cannot know when a Run ends
 * without watching the transcript, and a composer that watched the transcript would be the panel.
 *
 * **The candidate snapshot.** Indexing the workspace is Workspace_Services' and the panel's; this
 * component takes candidates and builds a Fuse index over them when they change.
 *
 * **Permission_Mode.** It lives in the header (R11.1) and arrives as a prop, because the consequence line
 * is the one place both axes are read together and neither axis is derived from the other (R11.10).
 *
 * ## Why no refusal is stored
 *
 * Every reason a send cannot happen is derived from the current draft, mode, workspace and model, so the
 * sentence under the send button is computed on each render and never held. It used to be held, and the
 * held copy could only ever be stale: pressing send in `Agent` with no folder open stored "Agent needs a
 * folder open", and switching to `Ask` — the fix the sentence itself proposes — left it on screen under a
 * button that had just become live. A refusal is a fact about the current state, and a user who has
 * already fixed it should not have to press send again to find out.
 *
 * The same shape twice would have been the bug twice: `sendBlockedReason` (R13.3) is not stored either.
 *
 * ## The two marks
 *
 * `markSubmit` is called here, in the send handler, and `markFirstPaint` by the transcript when it commits
 * the first delta (17.1). The measure between them is R20.1's budget, taken at the two points a user would
 * recognise: the moment they pressed send, and the moment something appeared. Both live in
 * `first-part-latency.ts` so the pair cannot drift apart.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "@/lib/utils";
import type { ConversationMode } from "@zoc-studio/shared-types";
import { AttachmentTray } from "./AttachmentTray";
import type { ComposerAttachment } from "./attachment-model";
import { PromptLibraryControl } from "./PromptLibraryControl";
import { ComposerInput } from "./ComposerInput";
import { ContextMeter } from "./ContextMeter";
import { ConversationModeControl } from "./ConversationModeControl";
import { EffortControl } from "./EffortControl";
import { MentionChips } from "./MentionChips";
import { MentionPopover } from "./MentionPopover";
import { ModeConsequenceLine } from "./ModeConsequenceLine";
import { SendControl } from "./SendControl";
import { VoiceInputControl } from "./VoiceInputControl";
import type { TranscriptionBackend } from "./voice-input";
import { contextFigures, type ContextCensus, type ModelReference } from "./context-figures";
import {
  MENTION_DEBOUNCE_MS,
  buildMentionIndex,
  clampSelection,
  mentionKindOf,
  nextSelection,
  type MentionCandidate,
  type MentionResult,
} from "./mention-index";
import { applyMention, detectMentionQuery } from "./mention-query";
import type { PermissionMode } from "./mode-consequence";
import { checkSubmission, refusalIsWorthStating } from "./submission-gate";
import { markSubmit } from "../first-part-latency";
import { registerChatKeyboard, type RunLifecycleState } from "../gating/keyboard-actions";
import { requestableMentions, useChatSurface, type Effort, type ResolvedMention } from "../store";

export interface ComposerSubmission {
  readonly text: string;
  /** Resolved attachments only: an unresolved chip is excluded (R12.7). */
  readonly mentions: readonly ResolvedMention[];
  /** The selected mode, always — never inferred from the draft (R32.2). */
  readonly mode: ConversationMode;
  readonly effort: Effort;
  /** Native file parts for this turn, retained by value when the submission is queued. */
  readonly attachments?: readonly ComposerAttachment[];
}

export interface ComposerProps {
  /** True while a Run is in flight. The composer stays usable (R8.7). */
  streaming: boolean;
  /** The mention snapshot. Re-indexed when this changes, not per keystroke. */
  candidates: readonly MentionCandidate[];
  model: ModelReference;
  census: ContextCensus;
  /** The header's axis (R11.1), read here only for the consequence line. */
  permissionMode: PermissionMode;
  workspaceRoot: string | null;
  onSubmit: (submission: ComposerSubmission) => void;
  /** `POST /v1/sessions/:id/compact` (R34.4). */
  onCompact?: () => void;
  /** Messages the panel is holding behind the current Run. */
  queued?: number;
  /**
   * A reason the host cannot start a Run at all, or `null` — R13.3's keyless cloud model.
   *
   * Blocks send and states the reason, and deliberately does *not* disable the composer: the fix is a key,
   * not a different sentence, and disabling the textarea would throw away the draft the user would send
   * the moment the key lands. Separate from `disabled` for that reason, and separate from the mode gate
   * because nothing the user types can clear it.
   */
  sendBlockedReason?: string | null;
  /** A read-only viewer (R1.4). Not used for streaming, which keeps the composer live. */
  disabled?: boolean;
  /**
   * Stop the in-flight Run — what `mod+.` fires (R20.4), not a control this component renders.
   *
   * Taken here rather than left in the panel because the two global bindings need *one* target, and the
   * composer is the half that owns the submit. Registering them separately would let a window hold a
   * submit from one panel and a cancel from another.
   */
  onCancelRun?: () => void;
  /** The Run's lifecycle state, so `mod+.` fires only while a Slot is still held (R20.4). */
  runState?: RunLifecycleState;
  /** Null/absent hides the control entirely (R31.5). */
  transcriptionBackend?: TranscriptionBackend | null;
  className?: string;
}

export function Composer({
  streaming,
  candidates,
  model,
  census,
  permissionMode,
  workspaceRoot,
  onSubmit,
  onCompact,
  queued = 0,
  sendBlockedReason = null,
  disabled = false,
  onCancelRun,
  runState = "idle",
  transcriptionBackend = null,
  className,
}: ComposerProps) {
  const draft = useChatSurface((state) => state.draft);
  const mentions = useChatSurface((state) => state.mentions);
  const conversationMode = useChatSurface((state) => state.conversationMode);
  const effort = useChatSurface((state) => state.effort);
  const setDraft = useChatSurface((state) => state.setDraft);
  const addMention = useChatSurface((state) => state.addMention);
  const removeMention = useChatSurface((state) => state.removeMention);
  const setConversationMode = useChatSurface((state) => state.setConversationMode);
  const setEffort = useChatSurface((state) => state.setEffort);
  const setMentionQuery = useChatSurface((state) => state.setMentionQuery);
  const mentionQuery = useChatSurface((state) => state.mentionQuery);

  const [caret, setCaret] = useState(0);
  const [attachments, setAttachments] = useState<readonly ComposerAttachment[]>([]);
  const [debouncedQuery, setDebouncedQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const anchorRef = useRef<HTMLDivElement | null>(null);

  // Built when the snapshot changes and not per keystroke: R12.2's 100 ms budget is over a 20,000-path
  // index, and preparing one is the expensive half of the work.
  const index = useMemo(() => buildMentionIndex(candidates), [candidates]);

  // The debounce is *when to ask*, which is this component's; the answer is the index's.
  useEffect(() => {
    if (mentionQuery === null) {
      setDebouncedQuery(null);
      return;
    }
    const timer = setTimeout(() => {
      setDebouncedQuery(mentionQuery.query);
    }, MENTION_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [mentionQuery]);

  const results: readonly MentionResult[] = useMemo(
    () => (debouncedQuery === null ? [] : index.search(debouncedQuery)),
    [index, debouncedQuery],
  );

  // The list changed under the selection — a keystroke narrowed it — so the highlight moves to something
  // that exists rather than off the end.
  useEffect(() => {
    setSelected((current) => clampSelection(current, results.length));
  }, [results]);

  const popoverOpen = mentionQuery !== null && results.length > 0;

  const contextItems = useMemo<readonly ResolvedMention[]>(
    () => [
      ...mentions,
      ...attachments.map((attachment) => ({
        id: `attachment:${attachment.id}`,
        kind: "doc" as const,
        ref: attachment.name,
        label: attachment.name,
        estimatedTokens: attachment.estimatedTokens,
        resolved: true,
      })),
    ],
    [mentions, attachments],
  );

  const figures = useMemo(
    () => contextFigures({ model, census, mentions: contextItems }),
    [model, census, contextItems],
  );

  const verdict = useMemo(
    () => checkSubmission({ mode: conversationMode, workspaceRoot, draft }),
    [conversationMode, workspaceRoot, draft],
  );

  // R12.6: overflow blocks submission. Checked beside the gate rather than inside it, because the gate is
  // about the *mode* contract and this is about the request's size — two reasons a send cannot happen, and
  // conflating them would put a token count in a policy module.
  const blocked = sendBlockedReason !== null || !verdict.permitted || figures.overflowing;
  // Derived, never stored, so it cannot outlive what it describes — and so the three are ranked in one
  // place rather than by whichever branch of `send` ran last.
  //
  // The host's reason first: a missing key is the one of the three the user cannot clear from here, so
  // reporting the overflow instead would name the second thing they have to fix.
  const blockingReason =
    sendBlockedReason ??
    (figures.overflowing
      ? `The attached context is over ${model.modelId}'s window. Remove an attachment to send.`
      : !verdict.permitted && refusalIsWorthStating(verdict)
        ? verdict.message
        : null);

  const handleChange = (next: { readonly text: string; readonly caret: number }) => {
    setDraft(next.text);
    setCaret(next.caret);
    setMentionQuery(detectMentionQuery(next.text, next.caret));
  };

  const acceptMention = (result: MentionResult) => {
    if (mentionQuery === null) return;
    const applied = applyMention(draft, mentionQuery.start, caret, result.candidate.ref);
    setDraft(applied.text);
    setCaret(applied.caret);
    addMention({
      id: result.candidate.id,
      kind: mentionKindOf(result.candidate.category),
      ref: result.candidate.ref,
      estimatedTokens: result.candidate.estimatedTokens,
      resolved: true,
    });
    // The trailing space `applyMention` writes is what closes the popover: the caret is no longer inside
    // an `@token`, so there is no active query to keep it open.
    setMentionQuery(detectMentionQuery(applied.text, applied.caret));
  };

  const send = () => {
    // R20.1's clock starts at the gesture, not at the request: what the budget is about is how long the
    // user waits, and the gate below can refuse without a Run ever being opened.
    markSubmit();

    // Inside `send` rather than only on the control: Enter in the textarea calls this directly, so a
    // disabled button alone would leave the keyboard path open (R13.3, R32.15). Each of the three refuses
    // in silence, because `blockingReason` is already saying it — the sentence is rendered from the state
    // that produced it rather than latched here, so it appears before the user presses anything and goes
    // when the state does.
    if (sendBlockedReason !== null) return;
    // Recomputed rather than read off `verdict`, so the mode the request carries is the one checked in the
    // same breath. The composer stays enabled through the refusal (R32.14, R32.15).
    const decision = checkSubmission({ mode: conversationMode, workspaceRoot, draft });
    if (!decision.permitted) return;
    if (figures.overflowing) return;

    onSubmit({
      text: draft.trim(),
      mentions: requestableMentions(mentions),
      mode: decision.mode,
      effort,
      attachments,
    });
    setDraft("");
    setAttachments([]);
    setMentionQuery(null);
  };

  // ── The two global shortcuts (R20.3, R20.4, task 24.2) ───────────────
  //
  // `lib/key-bindings.ts` fires `mod+enter` / `mod+.` when focus is outside a text field, and what it
  // fires is this. Published through a ref so the listener reads the *current* render's values: the
  // verdict changes on every keystroke, and a captured one is how a keystroke starts a Run the button
  // had just refused. `enabled` is the same expression `SendControl` receives, so the keyboard cannot
  // disagree with the control it shadows — that identity is the whole of R20.3.
  const enabled = !blocked && !disabled;
  const latest = useRef({ enabled, send, runState, onCancelRun });
  latest.current = { enabled, send, runState, onCancelRun };
  useEffect(
    () =>
      registerChatKeyboard({
        verdict: () => ({ canStart: latest.current.enabled }),
        submit: () => {
          latest.current.send();
        },
        runStates: () => [latest.current.runState],
        cancel: () => {
          latest.current.onCancelRun?.();
        },
      }),
    [],
  );

  return (
    <div
      className={cn("flex flex-col px-4 pb-3", className)}
      data-zoc-composer=""
      style={{ gap: "var(--zoc-row-gap-tight)" }}
    >
      <MentionChips mentions={mentions} onRemove={removeMention} />

      <MentionPopover
        open={popoverOpen}
        results={results}
        selected={selected}
        onSelect={acceptMention}
        onHighlight={(index) => {
          // The pointer moved over a row. Taken as the selection rather than ignored, so `Enter` inserts
          // the row under the cursor instead of the one the arrows last reached.
          setSelected(index);
        }}
        onOpenChange={(next) => {
          if (!next) setMentionQuery(null);
        }}
      >
        <div
          ref={anchorRef}
          className="rounded-[var(--zoc-radius-card)] border px-2 py-1.5"
          style={{ backgroundColor: "var(--zoc-elev-1)", borderColor: "var(--zoc-border)" }}
        >
          <ComposerInput
            value={draft}
            onChange={handleChange}
            onSubmit={send}
            onEscape={() => {
              // Esc closes the popover if one is open, and clears the draft otherwise. One key, two jobs,
              // and the order matters: a user dismissing a picker does not expect to lose their sentence.
              if (mentionQuery !== null) setMentionQuery(null);
              else setDraft("");
            }}
            popoverOpen={popoverOpen}
            onAcceptMention={() => {
              const result = results[selected];
              if (result !== undefined) acceptMention(result);
            }}
            onMoveSelection={(delta) => {
              setSelected((current) => nextSelection(current, results.length, delta));
            }}
            disabled={disabled}
          />
        </div>
      </MentionPopover>

      {/* Its own container, so the two mode axes degrade independently of the header's controls. */}
      <div className="zoc-composer-controls flex flex-wrap items-center gap-2">
        <ConversationModeControl value={conversationMode} onChange={setConversationMode} />
        <EffortControl value={effort} onChange={setEffort} />
        <PromptLibraryControl composerValue={draft} onInsert={setDraft} />
        <AttachmentTray
          attachments={attachments}
          supportsImages={model.supportsImages === true}
          disabled={disabled}
          onAdd={(attachment) => {
            setAttachments((current) => [...current, attachment]);
          }}
          onRemove={(id) => {
            setAttachments((current) => current.filter((attachment) => attachment.id !== id));
          }}
        />
        <VoiceInputControl
          backend={transcriptionBackend}
          value={draft}
          onChange={setDraft}
          disabled={disabled}
        />
        <span className="flex-1" />
        <ContextMeter
          model={model}
          census={census}
          mentions={contextItems}
          onRemoveMentions={(ids) => {
            for (const id of ids) {
              if (id.startsWith("attachment:")) {
                const attachmentId = id.slice("attachment:".length);
                setAttachments((current) =>
                  current.filter((attachment) => attachment.id !== attachmentId),
                );
              } else {
                removeMention(id);
              }
            }
          }}
          {...(onCompact === undefined ? {} : { onCompact })}
        />
        <SendControl
          streaming={streaming}
          enabled={enabled}
          reason={blockingReason}
          queued={queued}
          onSend={send}
        />
      </div>

      <ModeConsequenceLine mode={conversationMode} permissionMode={permissionMode} />
    </div>
  );
}
