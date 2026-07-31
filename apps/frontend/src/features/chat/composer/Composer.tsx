/**
 * The composer — zoc-agent-chat-rebuild R8.7, R11.10, R12.1–R12.7, R32.1, R32.2, R32.13–R32.15,
 * task 20.2.
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
import { ComposerInput } from "./ComposerInput";
import { ContextMeter } from "./ContextMeter";
import { ConversationModeControl } from "./ConversationModeControl";
import { EffortControl } from "./EffortControl";
import { MentionChips } from "./MentionChips";
import { MentionPopover } from "./MentionPopover";
import { ModeConsequenceLine } from "./ModeConsequenceLine";
import { SendControl } from "./SendControl";
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
import { requestableMentions, useChatSurface, type Effort, type ResolvedMention } from "../store";

export interface ComposerSubmission {
  readonly text: string;
  /** Resolved attachments only: an unresolved chip is excluded (R12.7). */
  readonly mentions: readonly ResolvedMention[];
  /** The selected mode, always — never inferred from the draft (R32.2). */
  readonly mode: ConversationMode;
  readonly effort: Effort;
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
  /** A read-only viewer (R1.4). Not used for streaming, which keeps the composer live. */
  disabled?: boolean;
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
  disabled = false,
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
  const [debouncedQuery, setDebouncedQuery] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
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

  const figures = useMemo(
    () => contextFigures({ model, census, mentions }),
    [model, census, mentions],
  );

  const verdict = useMemo(
    () => checkSubmission({ mode: conversationMode, workspaceRoot, draft }),
    [conversationMode, workspaceRoot, draft],
  );

  // R12.6: overflow blocks submission. Checked beside the gate rather than inside it, because the gate is
  // about the *mode* contract and this is about the request's size — two reasons a send cannot happen, and
  // conflating them would put a token count in a policy module.
  const blocked = !verdict.permitted || figures.overflowing;
  const blockingReason = figures.overflowing
    ? `The attached context is over ${model.modelId}'s window. Remove an attachment to send.`
    : !verdict.permitted && refusalIsWorthStating(verdict)
      ? verdict.message
      : null;

  const handleChange = (next: { readonly text: string; readonly caret: number }) => {
    setDraft(next.text);
    setCaret(next.caret);
    setRefusal(null);
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

    const decision = checkSubmission({ mode: conversationMode, workspaceRoot, draft });
    if (!decision.permitted) {
      // The composer stays enabled and states the reason (R32.14, R32.15).
      setRefusal(refusalIsWorthStating(decision) ? decision.message : null);
      return;
    }
    if (figures.overflowing) {
      setRefusal(blockingReason);
      return;
    }

    onSubmit({
      text: draft.trim(),
      mentions: requestableMentions(mentions),
      mode: decision.mode,
      effort,
    });
    setDraft("");
    setMentionQuery(null);
    setRefusal(null);
  };

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
        <AttachmentTray />
        <span className="flex-1" />
        <ContextMeter
          model={model}
          census={census}
          mentions={mentions}
          onRemoveMentions={(ids) => {
            for (const id of ids) removeMention(id);
          }}
          {...(onCompact === undefined ? {} : { onCompact })}
        />
        <SendControl
          streaming={streaming}
          enabled={!blocked && !disabled}
          reason={refusal ?? blockingReason}
          queued={queued}
          onSend={send}
        />
      </div>

      <ModeConsequenceLine mode={conversationMode} permissionMode={permissionMode} />
    </div>
  );
}
