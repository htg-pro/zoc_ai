/**
 * Chat_Surface UI-message typing — zoc-agent-chat-rebuild R7.1, R7.2, R7.9,
 * R7.11, R12.8, R30.4, R32.16.
 *
 * Type safety is established once, here, at the top of the Chat_Surface. Every
 * row component and the transport take their part types from this module rather
 * than re-deriving them, so a wire change is a single compile error rather than
 * a scatter of them.
 */

import type { UIMessage } from "ai";
import type {
  CompactionPart,
  ConversationMode,
  DiffPart,
  ErrorPart,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
  SourcePart,
  UsagePart,
} from "@zoc-studio/shared-types";

/** Per-message metadata written on finish (R15.2, R27.1). */
export interface ZocMessageMetadata {
  runId: string;
  provider: string;
  model: string;
  /**
   * The Conversation_Mode this Run was submitted in (R7.11, R32.16). Written
   * here as well as on the request, so a restored Session recovers the mode it
   * last submitted without replaying parts.
   */
  conversationMode: ConversationMode;
  startedAt: string;
  finishedAt: string | null;
  inputTokens: number;
  outputTokens: number;
  estimatedCostCents: number | null;
  /**
   * Token_Rate for this Run (R13.10). Mirrored from the terminal `UsagePart` so
   * a restored transcript's usage row shows the rate without replaying the
   * stream. Null when the Run produced no output tokens.
   */
  tokensPerSecond: number | null;
  /**
   * The context census as of this Run's assembly (R12.8) — the same four fields
   * `UsagePart` carries — mirrored for the same reason: a reopened Session shows
   * real figures before its next Run streams a `UsagePart`. Without them the
   * meter reads zero on restore, which is indistinguishable from an empty
   * context.
   */
  messagesInContext: number;
  sessionMessageCount: number;
  messagesOutOfWindow: number;
  summaryActive: boolean;
  /** Rules sources applied to this Run (R30.4). Populated in M1. */
  rulesSources: string[];
}

/**
 * The eight Zoc-specific data parts. Keys are the `data-` suffix; `useChat`
 * surfaces them as parts of type `data-zoc-plan`, `data-zoc-diff`, and so on.
 *
 * Eight, not six: `zoc-source` and `zoc-compaction` are declared in M1 (R7.9)
 * for the same reason the Pydantic union declares their parts — the map is final
 * from the first persisted transcript, so the M2 work that fills `zoc-source`
 * adds no wire change. Of the two, only `zoc-source` is producerless in M1;
 * `zoc-compaction` is written by the M1 compaction module and rendered by an M1
 * row.
 *
 * The native `source-url` / `source-document` parts are deliberately absent —
 * they are native parts rather than data parts, and they arrive on the same
 * message alongside `zoc-source`.
 *
 * A `type` rather than an `interface`: the AI SDK's `UIDataTypes` constraint is
 * `Record<string, unknown>`, and only an object *type* gets the implicit index
 * signature that satisfies it. Rewriting this as an interface for consistency
 * with `ZocMessageMetadata` fails the constraint — a compile error rather than a
 * subtle bug, but worth the comment, because it is the obvious tidy-up.
 */
export type ZocDataParts = {
  "zoc-plan": PlanPart;
  "zoc-diff": DiffPart;
  "zoc-permission": PermissionRequestPart;
  "zoc-run": RunLifecyclePart;
  "zoc-usage": UsagePart;
  "zoc-error": ErrorPart;
  "zoc-source": SourcePart;
  "zoc-compaction": CompactionPart;
};

export type ZocUIMessage = UIMessage<ZocMessageMetadata, ZocDataParts>;
