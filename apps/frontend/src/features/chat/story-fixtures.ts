/**
 * Fixtures for the Ladle stories — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * One module rather than a `const` block at the top of each of the eight story files, for the
 * reason 27.1 exists at all: the stories are a *comparison* surface. A reviewer looking at
 * `AnswerRow` beside `UserTurnRow` beside `ReasoningRow` is judging the three-tier hierarchy, and
 * three files that each invented their own prose, token counts, and paths would make every
 * difference on screen ambiguous — is that row heavier because of its tier, or because someone
 * typed a longer sentence into its story?
 *
 * Not in `__tests__`, and not exported from a test file: Ladle builds these through Vite, and the
 * vitest environment is not in that graph. The shapes are the wire contract's own, so a part that
 * gains a required field breaks `pnpm typecheck` here in the same commit it breaks the app.
 */
import type {
  CompactionPart,
  DiffPart,
  ErrorPart,
  PartBase,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
  Session,
  SourcePart,
  UsagePart,
} from "@zoc-studio/shared-types";

import type { ContextCensus, ModelReference } from "./composer/context-figures";
import type { MentionCandidate, MentionResult } from "./composer/mention-index";
import type { ModelChoice } from "./header/model-catalogue";
import { collapseHistorical, type HistoricalEvent, type HistoricalItem } from "./historical-rows";
import type { ApplyReceipt } from "./review/apply-receipt";
import type { ResolvedMention } from "./store";
import type { ToolEntryModel } from "./timeline/tool-entry-model";
import type { TranscriptRow } from "./transcript-model";
import type { ZocUIMessage } from "./wire/ui-message";

const RUN_ID = "run-7f2a";
const TS = "2026-07-31T10:00:04.000Z";

/** The envelope every part carries. `seq` is the only field a story ever needs to vary. */
export function base(seq: number, messageId = "m-assistant"): PartBase {
  return { seq, runId: RUN_ID, messageId, ts: TS };
}

export const MODEL: ModelReference = {
  provider: "anthropic",
  modelId: "claude-opus-5",
  contextLimit: 200_000,
};

/**
 * A census a third of the way into the window, with turns already out of it.
 *
 * Deliberately not near a threshold: the meter's warning bands are 20.3's, and a fixture sitting at
 * 78 % would make every story that renders a composer look like a warning story.
 */
export const CENSUS: ContextCensus = {
  messagesInContext: 12,
  sessionMessageCount: 40,
  messagesOutOfWindow: 28,
  summaryActive: false,
  consumedTokens: 64_000,
  measuredAgainst: MODEL,
};

/** The census the `ContextMeter` shows once it is close to the limit, for the loaded state. */
export const CENSUS_NEAR_LIMIT: ContextCensus = {
  ...CENSUS,
  messagesInContext: 96,
  consumedTokens: 186_000,
  summaryActive: true,
};

/**
 * Three models, one per key state the picker has to distinguish: local (no key at all), cloud with
 * a key, cloud without one. The third is what R13.3's key-entry affordance hangs off.
 */
export const MODELS: readonly ModelChoice[] = [
  {
    provider: "llamacpp",
    providerLabel: "Local",
    modelId: "qwen3-coder-30b-a3b-q4",
    label: "Qwen3 Coder 30B A3B",
    requiresKey: false,
    hasKey: false,
    local: true,
    meanTokensPerSecond: 38,
    contextLimit: 32_768,
  },
  {
    provider: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-opus-5",
    label: "Claude Opus 5",
    requiresKey: true,
    hasKey: true,
    local: false,
    contextLimit: 200_000,
  },
  {
    provider: "openai",
    providerLabel: "OpenAI",
    modelId: "gpt-5.2",
    label: "GPT-5.2",
    requiresKey: true,
    hasKey: false,
    local: false,
    contextLimit: 400_000,
  },
];

export const MENTIONS: readonly ResolvedMention[] = [
  {
    id: "mention-1",
    kind: "file",
    ref: "apps/frontend/src/features/chat/Transcript.tsx",
    label: "Transcript.tsx",
    estimatedTokens: 2_400,
    resolved: true,
  },
  {
    id: "mention-2",
    kind: "symbol",
    ref: "rowsOfMessage",
    label: "rowsOfMessage",
    estimatedTokens: 320,
    resolved: true,
  },
  // Unresolved, because the chip has a distinct rendering for a reference the workspace no longer
  // has — a file the model named after it was deleted is the case that produced the state.
  {
    id: "mention-3",
    kind: "file",
    ref: "apps/frontend/src/features/agent/rows.tsx",
    label: "rows.tsx",
    estimatedTokens: 0,
    resolved: false,
  },
];

export const CANDIDATES: readonly MentionCandidate[] = [
  {
    id: "files:1",
    category: "files",
    ref: "apps/frontend/src/features/chat/Transcript.tsx",
    label: "Transcript.tsx",
    detail: "apps/frontend/src/features/chat",
    estimatedTokens: 2_400,
  },
  {
    id: "files:2",
    category: "files",
    ref: "apps/frontend/src/features/chat/TranscriptRowView.tsx",
    label: "TranscriptRowView.tsx",
    detail: "apps/frontend/src/features/chat",
    estimatedTokens: 1_800,
  },
  {
    id: "symbols:1",
    category: "symbols",
    ref: "rowsOfMessage",
    label: "rowsOfMessage",
    detail: "transcript-model.ts",
    estimatedTokens: 320,
  },
];

export const MENTION_RESULTS: readonly MentionResult[] = CANDIDATES.map((candidate, index) => ({
  candidate,
  score: 1 - index * 0.1,
}));

export const USAGE: UsagePart = {
  ...base(41),
  type: "usage",
  inputTokens: 12_400,
  outputTokens: 1_860,
  reasoningTokens: 640,
  cachedInputTokens: 8_000,
  contextLimit: 200_000,
  estimatedCostCents: 7,
  tokensPerSecond: 42,
  messagesInContext: 12,
  sessionMessageCount: 40,
  messagesOutOfWindow: 28,
  summaryActive: false,
};

/** A retryable failure — the one that offers the `Retry` control (R16.6). */
export const ERROR_RETRYABLE: ErrorPart = {
  ...base(42),
  type: "error",
  code: "provider_overloaded",
  message: "The provider is overloaded.",
  details: "529 from api.anthropic.com after 3 attempts.",
  retryable: true,
};

/** A permanent failure, so the same row can be seen without a control. */
export const ERROR_TERMINAL: ErrorPart = {
  ...base(43),
  type: "error",
  code: "mode_not_permitted",
  message: "Ask mode cannot edit files.",
  details: null,
  retryable: false,
};

/**
 * An interrupted Run, which is the *lifecycle* form of an error row and the only one that offers
 * `Continue` (R16.5). Kept distinct from `ErrorPart` because `ErrorRow` accepts either and the two
 * take different control sets — a story with only the part form would never show the second.
 */
export const RUN_INTERRUPTED: RunLifecyclePart = {
  ...base(44),
  type: "run-lifecycle",
  state: "interrupted",
  code: "transport_interrupted",
  message: "The stream dropped after the reconnect budget was spent.",
};

export const COMPACTION: CompactionPart = {
  ...base(45),
  type: "compaction",
  compactionId: "compaction-1",
  foldedMessageIds: ["m-1", "m-2", "m-3", "m-4"],
  foldedTurnCount: 4,
  contextTokensBefore: 184_000,
  contextTokensAfter: 42_000,
  summary:
    "Four turns folded: the reader was repointed at the runtime stream, its test moved to `lib`, " +
    "and the two callers were updated.",
};

/** Resolves the folded ids above into turn labels, so `CompactionRow` shows turns not UUIDs. */
export const FOLDED_TURNS: ReadonlyMap<string, string> = new Map([
  ["m-1", "Repoint the reader at the runtime stream"],
  ["m-2", "Move the test to lib"],
  ["m-3", "Update the two callers"],
  ["m-4", "Run the suite"],
]);

const PATCH_MODIFY = `@@ -12,7 +12,9 @@
   const rows = rowsOfMessage(message, options);
-  return rows;
+  if (rows.length === 0) return EMPTY;
+  return rows;
 }`;

export const DIFF_FRESH: DiffPart = {
  ...base(46),
  type: "diff",
  planId: "plan-1",
  path: "apps/frontend/src/features/chat/transcript-model.ts",
  action: "modify",
  language: "typescript",
  baseDigest: "sha256:9f1c",
  stale: false,
  hunks: [
    { hunkId: "h1", oldStart: 12, oldLines: 7, newStart: 12, newLines: 9, patch: PATCH_MODIFY },
  ],
};

/** Stale, because R10.4's `Regenerate` path and the locked-hunk state exist only on this one. */
export const DIFF_STALE: DiffPart = {
  ...base(47),
  type: "diff",
  planId: "plan-1",
  path: "apps/frontend/src/features/chat/Transcript.tsx",
  action: "modify",
  language: "typescript",
  baseDigest: "sha256:1b7e",
  stale: true,
  hunks: [
    { hunkId: "h2", oldStart: 88, oldLines: 3, newStart: 88, newLines: 4, patch: PATCH_MODIFY },
  ],
};

export const DIFFS: readonly DiffPart[] = [DIFF_FRESH, DIFF_STALE];

export const PLAN: PlanPart = {
  ...base(48),
  type: "plan",
  planId: "plan-1",
  title: "Guard the empty row list",
  verificationCommand: "pnpm --filter @zoc-studio/frontend test transcript",
  files: [
    {
      path: "apps/frontend/src/features/chat/transcript-model.ts",
      action: "modify",
      rationale:
        "Return the shared empty array so a message with no renderable part is one identity.",
      addedLines: 2,
      removedLines: 0,
      hunkCount: 1,
    },
    {
      path: "apps/frontend/src/features/chat/Transcript.tsx",
      action: "modify",
      rationale: "Stop the virtualiser measuring a list it will never render.",
      addedLines: 1,
      removedLines: 0,
      hunkCount: 1,
    },
    // A hunkless rename, which is the one file-level accept `ApplySelection.acceptedFiles` is for.
    {
      path: "apps/frontend/src/features/chat/transcript-rows.ts",
      action: "rename",
      sourcePath: "apps/frontend/src/features/chat/rows.ts",
      rationale: "Name the module after what it holds.",
      addedLines: 0,
      removedLines: 0,
      hunkCount: 0,
    },
  ],
};

export const PERMISSION: PermissionRequestPart = {
  ...base(49),
  type: "permission-request",
  requestId: "req-1",
  toolCallId: "call-write-1",
  toolName: "workspace_apply_hunks",
  kind: "write",
  prompt: "Apply 2 hunks to transcript-model.ts?",
  paths: ["apps/frontend/src/features/chat/transcript-model.ts"],
  reason: "mode-ask",
  offeredScopes: ["call", "run", "workspace"],
  // Far enough out that the countdown is visible and does not expire while a reviewer looks at it.
  expiresAt: "2099-01-01T00:00:00.000Z",
};

export const SOURCE: SourcePart = {
  ...base(50),
  type: "source",
  toolName: "web_search",
  sources: [
    {
      sourceId: "s1",
      kind: "url",
      url: "https://example.invalid/spec",
      title: "The spec",
      mediaType: "text/html",
    },
  ],
  citations: [
    { sourceId: "s1", partId: "p1", start: 0, end: 24, quote: "append-only, seq-ordered" },
  ],
};

/** A `search` call, so the four-long consecutive run below clusters as one tool rather than four. */
function grep(pass: number): ToolEntryModel {
  return {
    toolCallId: `call-grep-${String(pass)}`,
    toolName: "workspace_grep",
    kind: "search",
    state: "succeeded",
    durationMs: 40 + pass * 14,
    summary: `Searched for rowsOfMessage, pass ${String(pass)}`,
    metric: `${String(pass * 3)} hits`,
  };
}

/**
 * One entry per `ToolEntryState`, then a four-call run of one tool.
 *
 * Four rather than three because `CLUSTER_THRESHOLD` is 3 and `groupTimeline` compares with `>`: a
 * three-call run stays individually legible, so a fixture of three would leave the clustered form —
 * the row R9.5 is actually about — visible in no story at all. The four share a tool name because
 * *consecutive same-tool* is what the grouping keys on, and they come last so the four states above
 * them stay individually readable.
 */
export const TOOL_ENTRIES: readonly ToolEntryModel[] = [
  {
    toolCallId: "call-read-1",
    toolName: "workspace_read",
    kind: "read",
    state: "succeeded",
    durationMs: 340,
    summary: "Read transcript-model.ts",
    input: '{\n  "path": "apps/frontend/src/features/chat/transcript-model.ts"\n}',
    output: "export function rowsOfMessage(…): readonly TranscriptRow[] { … }",
    readPaths: ["apps/frontend/src/features/chat/transcript-model.ts"],
    metric: "509L",
  },
  {
    toolCallId: "call-exec-1",
    toolName: "workspace_run_tests",
    kind: "execute",
    state: "running",
    durationMs: 8_200,
  },
  // Retryable, so `ToolTimeline`'s `onRetry` has somewhere to render (R9.6).
  {
    toolCallId: "call-write-1",
    toolName: "workspace_apply_hunks",
    kind: "write",
    state: "failed",
    durationMs: 120,
    error: {
      code: "stale_digest",
      message: "The file changed after the diff was produced.",
      retryable: true,
    },
    writtenPaths: ["apps/frontend/src/features/chat/transcript-model.ts"],
    metric: "+2 −0",
  },
  {
    toolCallId: "call-net-1",
    toolName: "web_search",
    kind: "network",
    state: "denied",
    durationMs: 0,
    error: {
      code: "mode_not_permitted",
      message: "Ask mode cannot reach the network.",
      retryable: false,
    },
  },
  ...[1, 2, 3, 4].map(grep),
];

const LEGACY_RUN = "legacy-run-3c81";

/**
 * A migrated conversation's leftovers, run through the real collapser rather than hand-written.
 *
 * `collapseHistorical` is what the transcript calls, so a story built on its output cannot show a
 * grouping the app would not produce — which is the failure mode of a literal `stage-run` fixture:
 * it renders whatever the author believed the rule was. Three consecutive `stage` events give the
 * `stage-run` arm, the `test-results` before them gives the `event` arm.
 */
const LEGACY_EVENTS: readonly HistoricalEvent[] = [
  {
    id: "h-1",
    runId: LEGACY_RUN,
    seq: 1,
    kind: "test-results",
    label: "Test results",
    ts: "2026-06-02T14:11:00.000Z",
    raw: { passed: 41, failed: 2, command: "pytest -q" },
    originalSeq: 214,
  },
  {
    id: "h-2",
    runId: LEGACY_RUN,
    seq: 2,
    kind: "stage",
    label: "Stage: ANALYZE",
    ts: "2026-06-02T14:11:02.000Z",
    raw: { stage: "ANALYZE" },
  },
  {
    id: "h-3",
    runId: LEGACY_RUN,
    seq: 3,
    kind: "stage",
    label: "Stage: PLAN",
    ts: "2026-06-02T14:11:05.000Z",
    raw: { stage: "PLAN" },
  },
  {
    id: "h-4",
    runId: LEGACY_RUN,
    seq: 4,
    kind: "stage",
    label: "Stage: APPLY",
    ts: "2026-06-02T14:11:09.000Z",
    raw: { stage: "APPLY" },
  },
];

export const HISTORICAL: readonly HistoricalItem[] = collapseHistorical(LEGACY_EVENTS);

export const HISTORICAL_ROWS: readonly TranscriptRow[] = HISTORICAL.map((item, index) => ({
  kind: "historical",
  id: `r-historical-${String(index)}`,
  item,
}));

/** The user's prompt, kept short: the user tier is the one that must not read as an answer. */
export const USER_PROMPT =
  "Guard the empty row list in the transcript factory, and say why the identity matters.";

/**
 * Assistant prose carrying the markdown the answer tier has to survive — a list, inline code, and a
 * closed fence. Deliberately one paragraph plus one fence rather than a wall: the three-tier
 * comparison is about weight, and a 300-word answer would win it by length alone.
 */
export const ANSWER_MARKDOWN = [
  "The factory returns the shared empty array now, so a message with no renderable part is one",
  "identity rather than a fresh `[]` per render.",
  "",
  "- `rowsOfMessage` guards before the loop",
  "- `Transcript` skips measurement for a list it will never draw",
  "",
  "```ts",
  "if (rows.length === 0) return EMPTY;",
  "```",
  "",
  "The remaining hunks are unaffected.",
].join("\n");

export const REASONING_TEXT =
  "The virtualiser keys its measurement cache on the row list's identity, so a fresh empty array " +
  "per render invalidates every measurement it holds. Returning a shared constant fixes that at " +
  "the source rather than in the component.";

/**
 * One row of every `TranscriptRow` kind, in transcript order — 17.5's visual-hierarchy check.
 *
 * Every kind including `sources`, which renders nothing until 36.4 builds its row. Present rather
 * than omitted, because `ROWS_AWAITING_A_RENDERER` names it as a known gap and a story that skipped
 * it would make the gap invisible in the one place it is meant to be looked at.
 */
export const EVERY_ROW: readonly TranscriptRow[] = [
  { kind: "user", id: "r-user", text: USER_PROMPT },
  {
    kind: "reasoning",
    id: "r-reasoning",
    text: REASONING_TEXT,
    streaming: false,
    terminal: true,
    elapsedMs: 4_200,
    redacted: false,
  },
  { kind: "tools", id: "r-tools", entries: TOOL_ENTRIES },
  { kind: "answer", id: "r-answer", text: ANSWER_MARKDOWN, streaming: false },
  { kind: "plan", id: "r-plan", plan: PLAN, diffs: DIFFS },
  { kind: "diff", id: "r-diff", diff: DIFF_STALE },
  { kind: "permission", id: "r-permission", request: PERMISSION },
  { kind: "usage", id: "r-usage", usage: USAGE, model: "claude-opus-5" },
  { kind: "error", id: "r-error", error: ERROR_RETRYABLE },
  { kind: "compaction", id: "r-compaction", compaction: COMPACTION },
  ...HISTORICAL_ROWS,
  { kind: "sources", id: "r-sources", source: SOURCE },
  { kind: "unknown", id: "r-unknown", discriminant: "data-zoc-telemetry" },
];

/** A diff whose plan is not in the message, which is the only way a `diff` row exists on its own. */
export const DIFF_ORPHAN: DiffPart = {
  ...DIFF_FRESH,
  ...base(51),
  planId: "plan-superseded",
  path: "apps/frontend/src/features/chat/JumpToLatest.tsx",
};

function metadataOf(runId: string): NonNullable<ZocUIMessage["metadata"]> {
  return {
    runId,
    provider: "anthropic",
    model: "claude-opus-5",
    conversationMode: "agent",
    startedAt: "2026-07-31T10:00:00.000Z",
    finishedAt: TS,
    inputTokens: USAGE.inputTokens,
    outputTokens: USAGE.outputTokens,
    estimatedCostCents: 7,
    tokensPerSecond: 42,
    messagesInContext: CENSUS.messagesInContext,
    sessionMessageCount: CENSUS.sessionMessageCount,
    messagesOutOfWindow: CENSUS.messagesOutOfWindow,
    summaryActive: false,
    rulesSources: [],
  };
}

type Part = ZocUIMessage["parts"][number];

/**
 * A `ToolEntryModel` turned back into the SDK tool part it came from.
 *
 * Derived rather than written out, so the timeline in the `Transcript` story and the one in the
 * timeline story are the same eight calls. A hand-written second copy is how the two drift into
 * showing different durations for the same fixture — and the timeline's whole job is to make
 * durations comparable.
 *
 * The Zoc additions ride on `callProviderMetadata`, which is where the SDK routes a chunk's
 * `providerMetadata` for every state except the two output ones; `zocMetaOf` merges both, so one
 * field serves all four states here. The cast is `fixture-entry.tsx`'s: a tool part is eight
 * state-shaped variants of one type and no exported member of the union describes a literal.
 */
function toolPartOf(entry: ToolEntryModel): Part {
  const state =
    entry.state === "succeeded"
      ? "output-available"
      : entry.state === "failed"
        ? "output-error"
        : entry.state === "denied"
          ? "output-denied"
          : "input-available";
  return {
    type: "dynamic-tool",
    toolName: entry.toolName,
    toolCallId: entry.toolCallId,
    state,
    ...(entry.input === undefined ? {} : { input: entry.input }),
    ...(entry.output === undefined ? {} : { output: entry.output }),
    ...(entry.error === undefined ? {} : { errorText: entry.error.message }),
    callProviderMetadata: {
      zoc: {
        kind: entry.kind,
        durationMs: entry.durationMs,
        ...(entry.summary === undefined ? {} : { summary: entry.summary }),
        ...(entry.metric === undefined ? {} : { metric: entry.metric }),
        ...(entry.readPaths === undefined ? {} : { readPaths: entry.readPaths }),
        ...(entry.writtenPaths === undefined ? {} : { writtenPaths: entry.writtenPaths }),
        ...(entry.error === undefined
          ? {}
          : { code: entry.error.code, retryable: entry.error.retryable }),
      },
    },
  } as unknown as Part;
}

/** A `data-zoc-*` part, whose `data` the row factory reads straight through. */
function dataPart(type: string, data: unknown): Part {
  return { type, data } as unknown as Part;
}

/**
 * A two-turn Session whose assistant turn carries every part the factory has an arm for.
 *
 * One assistant message rather than one per kind, because that is what a real Run looks like and
 * because it exercises the two orderings the factory decides: consecutive tool parts becoming a
 * single timeline, and the unknown-discriminant placeholder landing after the timeline it
 * interrupted rather than splitting it.
 *
 * The `historical` rows are not here — they reach the transcript through its `historicalRows` prop,
 * since nothing the runtime emits is historical. Use {@link HISTORICAL_ROWS} for that.
 */
export const MESSAGES: readonly ZocUIMessage[] = [
  {
    id: "m-user",
    role: "user",
    metadata: metadataOf(RUN_ID),
    parts: [{ type: "text", text: USER_PROMPT }],
  },
  {
    id: "m-assistant",
    role: "assistant",
    metadata: metadataOf(RUN_ID),
    parts: [
      { type: "reasoning", text: REASONING_TEXT, state: "done" },
      ...TOOL_ENTRIES.map(toolPartOf),
      // Between two tool parts on purpose: Property 3 requires this placeholder to leave the
      // timeline it interrupted as one row, and the story is where that is visible.
      dataPart("data-zoc-telemetry", { sampled: true }),
      {
        type: "text",
        text: ANSWER_MARKDOWN,
        state: "done",
        providerMetadata: { zoc: { partId: "p1" } },
      },
      dataPart("data-zoc-plan", PLAN),
      dataPart("data-zoc-diff", DIFF_FRESH),
      dataPart("data-zoc-diff", DIFF_STALE),
      dataPart("data-zoc-diff", DIFF_ORPHAN),
      dataPart("data-zoc-permission", PERMISSION),
      dataPart("data-zoc-source", SOURCE),
      dataPart("data-zoc-compaction", COMPACTION),
      dataPart("data-zoc-error", ERROR_RETRYABLE),
      dataPart("data-zoc-usage", USAGE),
    ],
  },
];

/** The same Session mid-Run: the answer is still arriving, so the caret and repair are live. */
export const STREAMING_MESSAGES: readonly ZocUIMessage[] = [
  {
    id: "m-user",
    role: "user",
    metadata: metadataOf(RUN_ID),
    parts: [{ type: "text", text: USER_PROMPT }],
  },
  {
    id: "m-assistant",
    role: "assistant",
    metadata: metadataOf(RUN_ID),
    parts: [
      { type: "reasoning", text: REASONING_TEXT.slice(0, 96), state: "streaming" },
      // An unclosed fence, which is the case the markdown repair exists for (R8.6).
      {
        type: "text",
        text: "Applying the guard now:\n\n```ts\nif (rows.length === 0) return EMP",
        state: "streaming",
      },
    ],
  },
];

/** `now` for the session list's relative timestamps, so "2h ago" is not "3 weeks ago" next month. */
export const NOW = Date.parse("2026-07-31T12:00:00.000Z");

export const WORKSPACE_ROOT = "/home/dev/zoc-studio";

function session(
  id: string,
  title: string,
  status: Session["status"],
  hoursAgo: number,
  workspaceRoot = WORKSPACE_ROOT,
): Session {
  const updated = new Date(NOW - hoursAgo * 3_600_000).toISOString();
  return {
    id,
    title,
    status,
    workspace_root: workspaceRoot,
    provider: MODEL.provider,
    model: MODEL.modelId,
    created_at: new Date(NOW - (hoursAgo + 2) * 3_600_000).toISOString(),
    updated_at: updated,
    messages: [],
    tool_calls: [],
  };
}

/**
 * Five Sessions, one per state the list renders differently: active, two idle, closed, and one in
 * another workspace.
 *
 * The last is the R15.10 check and is the reason this is a five-element fixture rather than a two —
 * the header's switcher must *not* show it, and the workspace surfaces must, so a story that omitted
 * it would make both behaviours look identical.
 */
export const SESSIONS: readonly Session[] = [
  session("s-1", "Guard the empty row list in the transcript factory", "active", 0.2),
  session("s-2", "Normalise the three error envelopes", "idle", 26),
  session("s-3", "Reasoning row retention on collapse", "idle", 74),
  session("s-4", "Ladle stories for the chat surface", "closed", 190),
  session("s-5", "Gateway session persistence", "idle", 5, "/home/dev/other-repo"),
];

/**
 * A partial apply, which is the only receipt shape worth a story.
 *
 * A clean one says "3 files, done" and needs no reading; R10.6's rollback and the per-file failure are
 * what a reviewer has to judge, and both exist only when something went wrong halfway.
 */
export const RECEIPT: ApplyReceipt = {
  checkpointId: "ckpt-4d19",
  files: [
    {
      path: "apps/frontend/src/features/chat/transcript-model.ts",
      action: "modify",
    },
  ],
  partial: true,
  rollbackable: true,
  summary: "Applied 1 of 2 files, then stopped.",
  rollbackActions: [
    "Restore apps/frontend/src/features/chat/transcript-model.ts to checkpoint ckpt-4d19.",
  ],
  failure: "Transcript.tsx changed after the diff was produced.",
};
