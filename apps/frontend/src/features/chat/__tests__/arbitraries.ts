/**
 * Chat_Surface property-test generators — the shared `fast-check` arbitraries the
 * Chat_Surface's property tests draw from.
 *
 * Seven generators live here. Two further ones deliberately do not: the
 * `(mode, planApproved, permissionMode, kind)` tuple stream for Properties 71–74
 * and the output-delta schedule for Property 85 belong to the Agent_Runtime's own
 * suite, because they generate runtime state the renderer never sees.
 *
 * Every generator builds its invariant into the *construction* rather than
 * filtering for it, so a shrunk counterexample is still a well-formed input and
 * cannot fail a property for the wrong reason. Where a variant exists only to
 * make an assertion meaningful, the comment says so — a reader who removes it as
 * decoration would silently weaken the property that depends on it.
 *
 * Feature: zoc-agent-chat-rebuild
 * Requirements: 22.2
 */

import fc from "fast-check";
import type {
  CompactionPart,
  ConversationMode,
  DiffPart,
  ErrorPart,
  Hunk,
  Message,
  MessagePart,
  ReasoningPart,
  RunLifecyclePart,
  RunState,
  Session,
  SessionStatus,
  TextPart,
  ToolErrorPart,
  ToolInputPart,
  ToolOutputPart,
  UsagePart,
} from "@zoc-studio/shared-types";

// ── Shared vocabulary ─────────────────────────────────────────────────────

/** The four `RunState`s that end a Run. `queued`, `running`, and
 *  `awaiting-approval` are the non-terminal three. */
export const TERMINAL_RUN_STATES = [
  "completed",
  "cancelled",
  "failed",
  "interrupted",
] as const satisfies ReadonlyArray<RunState>;

/**
 * The three Conversation_Modes, and the three Permission_Modes beside them.
 *
 * These are enumeration material, not generators: Property 76 asserts all nine
 * mode combinations exhaustively rather than sampling them, so what it needs is
 * the two lists to take a product over. `draftAndMode` draws a Conversation_Mode
 * from the first list and deliberately leaves the Permission_Mode axis alone.
 */
export const CONVERSATION_MODES = [
  "ask",
  "plan",
  "agent",
] as const satisfies ReadonlyArray<ConversationMode>;

export const PERMISSION_MODES = ["ask", "auto", "deny"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

const SESSION_STATUSES = [
  "active",
  "idle",
  "closed",
] as const satisfies ReadonlyArray<SessionStatus>;

/** A short id-like token. Hexadecimal so it survives a URL and a filename. */
const identifier = fc.hexaString({ minLength: 6, maxLength: 12 });

/** ISO-8601 instants from a bounded range, so ordering comparisons mean something. */
const isoTimestamp = fc
  .integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString());

/**
 * A deliberately small path alphabet. Small enough that collisions between two
 * generated plans actually happen, which is the case a per-path staleness or
 * per-path lock bug hides in.
 */
const PATH_DIRECTORIES = ["src", "lib", "tests", "docs", "apps"] as const;
const PATH_FILES = ["index.ts", "main.rs", "store.py", "README.md", "util.ts"] as const;

/** A workspace-relative file path over the small alphabet above. */
const workspacePath = fc
  .tuple(fc.constantFrom(...PATH_DIRECTORIES), fc.constantFrom(...PATH_FILES))
  .map(([directory, file]) => `${directory}/${file}`);

/**
 * Workspace roots over a small alphabet, **with trailing-separator and case
 * variants**.
 *
 * A building block of `sessionHistory` and `lifecycleActions` rather than an
 * eighth generator; exported because the root-variant invariant is worth
 * asserting on its own.
 *
 * The variants are load-bearing rather than decorative: they are what makes
 * Property 88's canonicalisation assertion meaningful. A scoping bug that
 * compares raw strings passes against a clean alphabet and fails only against
 * `/Work/Proj` versus `/work/proj/`, so an alphabet without those pairs would
 * report the bug as absent.
 */
export const workspaceRoot = fc
  .tuple(
    fc.constantFrom("/home/dev", "/Users/dev", "/work", "/Work"),
    fc.constantFrom("proj", "Proj", "PROJ", "my-proj"),
    fc.constantFrom("", "/", "//"),
  )
  .map(([base, name, tail]) => `${base}/${name}${tail}`);

function partBase(seq: number, runId: string, messageId: string, ts: string) {
  return { seq, runId, messageId, ts, agentName: null };
}

// ── 1. runPartSequence ────────────────────────────────────────────────────

type PartFactory = (seq: number, runId: string, messageId: string, ts: string) => MessagePart;

/**
 * The part kinds a Run emits that do not end it. `running` is the non-terminal
 * lifecycle state, included here so a sequence can carry lifecycle transitions
 * without acquiring a second terminal part.
 */
const NON_TERMINAL_KINDS = [
  "text",
  "reasoning",
  "tool-input",
  "tool-output",
  "tool-error",
  "usage",
  "error",
  "running",
] as const;

type NonTerminalKind = (typeof NON_TERMINAL_KINDS)[number];

const PART_FACTORIES: Record<NonTerminalKind, PartFactory> = {
  text: (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "text",
      partId: `t_${messageId}`,
      delta: "lorem ",
      done: false,
    }) satisfies TextPart,

  reasoning: (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "reasoning",
      partId: `r_${messageId}`,
      delta: "considering ",
      elapsedMs: seq * 40,
      done: false,
      redacted: false,
    }) satisfies ReasoningPart,

  "tool-input": (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "tool-input",
      toolCallId: `call_${seq}`,
      toolName: "workspace_read_file",
      kind: "read",
      mcpServer: null,
      inputDelta: '{"path":"src/index.ts"}',
      done: true,
    }) satisfies ToolInputPart,

  "tool-output": (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "tool-output",
      toolCallId: `call_${seq}`,
      durationMs: 12,
      summary: "read 1 file",
      output: "export const a = 1;",
      readPaths: ["src/index.ts"],
      writtenPaths: [],
      truncated: false,
    }) satisfies ToolOutputPart,

  "tool-error": (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "tool-error",
      toolCallId: `call_${seq}`,
      durationMs: 9,
      code: "workspace_unavailable",
      message: "The workspace service is restarting.",
      details: null,
      retryable: true,
    }) satisfies ToolErrorPart,

  usage: (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "usage",
      inputTokens: 100 * seq,
      outputTokens: 10 * seq,
      reasoningTokens: 0,
      cachedInputTokens: 0,
      contextLimit: 128_000,
      estimatedCostCents: null,
      tokensPerSecond: null,
      messagesInContext: seq,
      sessionMessageCount: seq,
      messagesOutOfWindow: 0,
      summaryActive: false,
    }) satisfies UsagePart,

  error: (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "error",
      code: "provider_unavailable",
      message: "The provider did not respond.",
      details: null,
      retryable: true,
    }) satisfies ErrorPart,

  running: (seq, runId, messageId, ts) =>
    ({
      ...partBase(seq, runId, messageId, ts),
      type: "run-lifecycle",
      state: "running",
      queuePosition: null,
      code: null,
      message: null,
      provider: "openai",
      model: "gpt-x",
    }) satisfies RunLifecyclePart,
};

function terminalPart(
  seq: number,
  runId: string,
  messageId: string,
  ts: string,
  state: (typeof TERMINAL_RUN_STATES)[number],
): RunLifecyclePart {
  // `failed` and `interrupted` carry a code by schema rule; the other two must
  // not invent one.
  const needsCode = state === "failed" || state === "interrupted";
  return {
    ...partBase(seq, runId, messageId, ts),
    type: "run-lifecycle",
    state,
    queuePosition: null,
    code: needsCode ? "stream_lost" : null,
    message: needsCode ? "The stream ended before the run finished." : null,
    provider: "openai",
    model: "gpt-x",
  };
}

/**
 * A well-formed Message_Part sequence for one Run.
 *
 * Two invariants are structural rather than filtered: `seq` runs `1..n` strictly
 * increasing with no gap, and there is **at most one terminal lifecycle part,
 * which is last when present**. Both are what Properties 1 and 2 assert about
 * the transport and the writer, so a generator that could violate them would
 * make those properties untestable rather than merely noisy.
 */
export const runPartSequence: fc.Arbitrary<MessagePart[]> = fc
  .tuple(
    identifier,
    identifier,
    isoTimestamp,
    fc.array(fc.constantFrom(...NON_TERMINAL_KINDS), { minLength: 1, maxLength: 400 }),
    fc.option(fc.constantFrom(...TERMINAL_RUN_STATES), { nil: null }),
  )
  .map(([run, message, ts, kinds, terminalState]) => {
    const runId = `run_${run}`;
    const messageId = `msg_${message}`;
    const parts: MessagePart[] = kinds.map((kind, index) =>
      PART_FACTORIES[kind](index + 1, runId, messageId, ts),
    );
    if (terminalState !== null) {
      parts.push(terminalPart(parts.length + 1, runId, messageId, ts, terminalState));
    }
    return parts;
  });

// ── 2. unreliableDelivery ─────────────────────────────────────────────────

export interface Delivery {
  /** What the runtime meant to send: gapless, ordered, complete. */
  readonly intended: readonly MessagePart[];
  /** What the client actually observes: duplicated, reordered, possibly cut. */
  readonly delivered: readonly MessagePart[];
  /** Maximum displacement the reordering applied. */
  readonly reorderWindow: number;
  /** Index in the reordered stream after which the connection dropped, or null. */
  readonly disconnectAfterIndex: number | null;
  /** The `seq` a client would resume from: the highest gapless prefix observed. */
  readonly resumeFromSeq: number;
}

/**
 * Reorder within a bounded window, which is what a real transport does — an
 * unbounded shuffle would model a hazard no network produces and would make the
 * bounded re-attach in the resume protocol untestable.
 */
function windowShuffle<T>(items: readonly T[], window: number, seed: number): T[] {
  const out = [...items];
  let state = seed | 1;
  for (let i = 0; i < out.length; i += 1) {
    state = (state * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    const span = Math.min(window, out.length - i);
    if (span <= 1) continue;
    const j = i + (state % span);
    const a = out[i];
    out[i] = out[j];
    out[j] = a;
  }
  return out;
}

/** The highest `n` such that every seq in `1..n` was delivered. */
function highestGaplessPrefix(parts: readonly MessagePart[]): number {
  const seen = new Set(parts.map((part) => part.seq));
  let n = 0;
  while (seen.has(n + 1)) n += 1;
  return n;
}

/**
 * A part stream that has been through a hostile transport: duplication, bounded
 * reordering, and a mid-stream disconnect with the `seq` a resume would start
 * from.
 *
 * The three hazards apply in the order a real network applies them — duplicate,
 * then reorder, then cut. Cutting first would make the other two unobservable
 * past the cut point, which is the shape of an easy false pass.
 */
export const unreliableDelivery: fc.Arbitrary<Delivery> = fc
  .tuple(
    runPartSequence,
    fc.array(fc.nat(), { maxLength: 8 }),
    fc.integer({ min: 1, max: 5 }),
    fc.integer({ min: 1, max: 0x7fff_fffe }),
    fc.option(fc.nat(), { nil: null }),
  )
  .map(([intended, duplicateAt, reorderWindow, seed, cutAt]) => {
    const duplicateIndices = new Set(duplicateAt.map((n) => n % intended.length));
    const duplicated: MessagePart[] = [];
    intended.forEach((part, index) => {
      duplicated.push(part);
      if (duplicateIndices.has(index)) duplicated.push(part);
    });

    const reordered = windowShuffle(duplicated, reorderWindow, seed);

    const disconnectAfterIndex = cutAt === null ? null : cutAt % reordered.length;
    const delivered =
      disconnectAfterIndex === null ? reordered : reordered.slice(0, disconnectAfterIndex + 1);

    return {
      intended,
      delivered,
      reorderWindow,
      disconnectAfterIndex,
      resumeFromSeq: highestGaplessPrefix(delivered),
    };
  });

// ── 3. diffPart ───────────────────────────────────────────────────────────

/**
 * One file's diff carrying **1–20 hunks whose line ranges do not overlap**.
 *
 * The action is drawn from `modify` and `rename` alone, and that is a
 * consequence of the hunk-count invariant rather than an oversight: by wire rule
 * a `create` or `delete` carries exactly one whole-file hunk and a pure `rename`
 * carries none, so drawing those here would contradict "1–20 hunks" on the same
 * generator. Those three shapes are covered by example — the design puts
 * per-action diff rendering in the unit-test set — and the apply/rollback
 * property over all four actions draws from the Agent_Runtime's own generator
 * against a real temp workspace.
 */
export const diffPart: fc.Arbitrary<DiffPart> = fc
  .tuple(
    identifier,
    identifier,
    isoTimestamp,
    workspacePath,
    fc.constantFrom("modify" as const, "rename" as const),
    fc.array(fc.tuple(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 0, max: 12 })), {
      minLength: 1,
      maxLength: 20,
    }),
  )
  .map(([run, plan, ts, path, action, spans]) => {
    const hunks: Hunk[] = [];
    let cursor = 1;
    spans.forEach(([gap, size], index) => {
      const oldStart = cursor + gap;
      // Advance past this hunk's range so the next one cannot touch it. The
      // trailing +1 is what makes "non-overlapping" true rather than likely.
      cursor = oldStart + size + 1;
      hunks.push({
        hunkId: `h_${index}`,
        oldStart,
        oldLines: size,
        newStart: oldStart,
        newLines: size + 1,
        patch:
          `@@ -${oldStart},${size} +${oldStart},${size + 1} @@\n` +
          `-const before = ${index};\n+const after = ${index};\n`,
      });
    });

    return {
      ...partBase(1, `run_${run}`, `msg_${run}`, ts),
      type: "diff",
      planId: `plan_${plan}`,
      path,
      action,
      // Both ends of a move, or neither. A rename with one path is refused at
      // the schema, so the generator must not produce one.
      sourcePath: action === "rename" ? `old/${path}` : null,
      language: "typescript",
      hunks,
      baseDigest: `sha256:${plan}`,
      // Staleness is injected by the property through the on-disk digest map, so
      // the runtime-detected flag starts clear.
      stale: false,
    } satisfies DiffPart;
  });

// ── 4. truncatedMarkdown ──────────────────────────────────────────────────

/**
 * Complete, valid markdown documents. Every string `truncatedMarkdown` produces
 * is a **prefix** of one of these, which is what makes "a prefix of a valid
 * markdown document" true of the generator by construction rather than by
 * inspection. Exported so a test can assert that.
 */
export const MARKDOWN_BODIES = [
  "Here is the change:\n\n```ts\nconst a = 1;\n```\n\nDone.",
  "A **bold** claim and an _aside_ plus `code`.",
  "See [the docs](https://example.invalid/docs) for detail.",
  "1. first\n2. second\n\n> a quote\n\n| a | b |\n| - | - |\n| 1 | 2 |",
  "Nested fence:\n\n```js\nconst x = `t`;\n```\n\nafter.",
  "An ![image](https://example.invalid/i.png) and a footnote[^1].",
] as const;

/** The markers whose interiors are the three truncations worth hitting. */
const MARKDOWN_MARKERS = ["```", "**", "_", "[", "](", "`"] as const;

/**
 * Cut offsets that land *inside* a construct rather than anywhere in the string.
 *
 * A uniform offset finds an unclosed fence, a dangling emphasis run, and a
 * half-written link eventually; drawing from these offsets finds all three in a
 * handful of samples, which is the difference between a property that catches a
 * repair bug on the first run and one that catches it on some later run.
 */
function constructInteriorOffsets(body: string): number[] {
  const offsets: number[] = [];
  for (const marker of MARKDOWN_MARKERS) {
    let from = 0;
    for (;;) {
      const at = body.indexOf(marker, from);
      if (at < 0) break;
      // Just inside the marker, and just past it: the two cuts that leave a
      // construct opened and unterminated.
      offsets.push(at + 1, at + marker.length);
      from = at + 1;
    }
  }
  return offsets.filter((offset) => offset > 0 && offset < body.length);
}

/**
 * Markdown cut at an arbitrary character — the way streamed markdown actually
 * arrives. Truncation is the operation the repair function has to survive, so
 * the generator cuts real documents rather than synthesising broken syntax.
 */
export const truncatedMarkdown: fc.Arbitrary<string> = fc
  .constantFrom(...MARKDOWN_BODIES)
  .chain((body) => {
    const interior = constructInteriorOffsets(body);
    const offset = fc.oneof(
      // Anywhere, including the empty prefix and the whole document.
      fc.integer({ min: 0, max: body.length }),
      // Inside a fence, an emphasis run, or a link.
      ...(interior.length > 0 ? [fc.constantFrom(...interior)] : []),
    );
    return offset.map((at) => body.slice(0, at));
  });

// ── 5. sessionHistory ─────────────────────────────────────────────────────

/** One fold, with the transcript position it occupies. */
export interface PositionedCompaction {
  /** Index of the last message this fold covers, into `session.messages`. */
  readonly afterMessageIndex: number;
  readonly part: CompactionPart;
}

export interface SessionFixture {
  readonly session: Session;
  /** 0–4 folds, ordered by position, each folding a prefix of the messages. */
  readonly compactions: readonly PositionedCompaction[];
}

function makeMessages(count: number, epochMs: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m_${i}`,
    // Alternating, starting with `user`, so a "whole turn" is a well-defined
    // pair and a folded prefix always contains at least one user turn.
    role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    content: `turn ${i}`,
    name: null,
    tool_call_id: null,
    created_at: new Date(epochMs + i * 1_000).toISOString(),
  }));
}

function makeSession(fields: {
  id: string;
  title: string;
  status: SessionStatus;
  workspaceRoot: string;
  provider: string | null;
  model: string | null;
  createdAtMs: number;
  messages: Message[];
}): Session {
  return {
    id: fields.id,
    title: fields.title,
    status: fields.status,
    workspace_root: fields.workspaceRoot,
    provider: fields.provider,
    model: fields.model,
    created_at: new Date(fields.createdAtMs).toISOString(),
    updated_at: new Date(fields.createdAtMs + fields.messages.length * 1_000).toISOString(),
    messages: fields.messages,
    plan: null,
    tool_calls: [],
  };
}

/**
 * A Session with 0–120 messages, a workspace root drawn with trailing-separator
 * and case variants, and 0–4 Compaction_Records at arbitrary positions.
 *
 * Feeds Properties 81, 82, 87, 88, and 89. Three details are deliberate:
 * `status` is drawn from all three values so the archive partition has both
 * sides to compare; a fold covers the message *prefix* through its position, so
 * a later fold's `foldedMessageIds` is the union of the earlier one's and the
 * newly folded ids, which is how the runtime accumulates them; and a Session
 * with no messages carries no folds at all, because a Compaction_Record that
 * folds nothing is refused at the schema.
 */
export const sessionHistory: fc.Arbitrary<SessionFixture> = fc
  .tuple(
    identifier,
    workspaceRoot,
    fc.constantFrom(...SESSION_STATUSES),
    fc.option(fc.constantFrom("openai", "anthropic", "local-llamacpp"), { nil: null }),
    fc.option(fc.constantFrom("gpt-x", "claude-y", "qwen-z"), { nil: null }),
    fc.integer({ min: 0, max: 120 }),
    fc.uniqueArray(fc.nat({ max: 119 }), { maxLength: 4 }),
    fc.integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 }),
  )
  .map(([id, root, status, provider, model, messageCount, foldAt, epochMs]) => {
    const messages = makeMessages(messageCount, epochMs);
    const session = makeSession({
      id: `sess_${id}`,
      title: messageCount > 0 ? messages[0].content : "New chat",
      status,
      workspaceRoot: root,
      provider,
      model,
      createdAtMs: epochMs,
      messages,
    });

    const positions = foldAt.filter((position) => position < messageCount).sort((a, b) => a - b);

    const compactions = positions.map((position, index) => {
      const folded = messages.slice(0, position + 1);
      const before = 10_000 + index * 1_000;
      const part: CompactionPart = {
        ...partBase(index + 1, `run_${id}_${index}`, `msg_${id}_${index}`, session.created_at),
        type: "compaction",
        compactionId: `cmp_${id}_${index}`,
        foldedMessageIds: folded.map((message) => message.id),
        // Whole user turns, and never zero: the prefix always starts at `m_0`,
        // which is a user message.
        foldedTurnCount: folded.filter((message) => message.role === "user").length,
        contextTokensBefore: before,
        // A fold that grew the context is refused at the schema.
        contextTokensAfter: Math.floor(before / 2),
        summary: `Folded ${folded.length} messages.`,
      };
      return { afterMessageIndex: position, part };
    });

    return { session, compactions };
  });

// ── 6. lifecycleActions ───────────────────────────────────────────────────

/**
 * One Session lifecycle action. `target` is a *selector*, not an index: the
 * harness resolves it modulo the live Session count when the action runs, so no
 * action in a sequence can name a Session that was already deleted or one that
 * never existed.
 */
export type LifecycleAction =
  | { readonly kind: "create"; readonly title: string }
  | { readonly kind: "rename"; readonly target: number; readonly title: string }
  | { readonly kind: "fork"; readonly target: number; readonly atMessage: number }
  | { readonly kind: "duplicate"; readonly target: number }
  | { readonly kind: "archive"; readonly target: number }
  | { readonly kind: "delete"; readonly target: number };

export interface LifecycleScenario {
  /** The Session set the sequence runs against. One shared workspace root, so
   *  the per-workspace filter cannot make every surface trivially empty. */
  readonly sessions: readonly Session[];
  readonly actions: readonly LifecycleAction[];
}

const lifecycleAction: fc.Arbitrary<LifecycleAction> = fc.oneof(
  fc.record({ kind: fc.constant("create" as const), title: fc.string({ maxLength: 40 }) }),
  fc.record({
    kind: fc.constant("rename" as const),
    target: fc.nat({ max: 20 }),
    title: fc.string({ maxLength: 40 }),
  }),
  fc.record({
    kind: fc.constant("fork" as const),
    target: fc.nat({ max: 20 }),
    atMessage: fc.nat({ max: 60 }),
  }),
  fc.record({ kind: fc.constant("duplicate" as const), target: fc.nat({ max: 20 }) }),
  fc.record({ kind: fc.constant("archive" as const), target: fc.nat({ max: 20 }) }),
  fc.record({ kind: fc.constant("delete" as const), target: fc.nat({ max: 20 }) }),
);

/**
 * A **sequence** of Session lifecycle actions over a generated Session set:
 * create, rename, fork at an arbitrary message, duplicate, archive, delete.
 *
 * Feeds Property 86. It draws sequences rather than single actions because the
 * interesting cases are the interleavings — delete then rename, archive then
 * fork, duplicate a fork — each individual action being trivially correct in
 * isolation.
 */
export const lifecycleActions: fc.Arbitrary<LifecycleScenario> = fc
  .tuple(
    workspaceRoot,
    fc.uniqueArray(identifier, { minLength: 1, maxLength: 6 }),
    fc.integer({ min: 1_700_000_000_000, max: 2_000_000_000_000 }),
    fc.array(lifecycleAction, { minLength: 1, maxLength: 24 }),
  )
  .chain(([root, ids, epochMs, actions]) =>
    fc
      .tuple(
        ...ids.map(() =>
          fc.tuple(fc.integer({ min: 0, max: 8 }), fc.constantFrom(...SESSION_STATUSES)),
        ),
      )
      .map((shapes) => ({
        sessions: ids.map((id, index) => {
          const [messageCount, status] = shapes[index];
          const createdAtMs = epochMs + index * 60_000;
          return makeSession({
            id: `sess_${id}`,
            title: `Session ${index}`,
            status,
            workspaceRoot: root,
            provider: null,
            model: null,
            createdAtMs,
            messages: makeMessages(messageCount, createdAtMs),
          });
        }),
        actions,
      })),
  );

// ── 7. draftAndMode ──────────────────────────────────────────────────────

/**
 * The retired prompt router's edit-intent vocabulary — the exact words
 * `routeModeForPrompt`'s `EDIT_INTENT_RE` keyed off, in its own order.
 */
export const RETIRED_ROUTER_EDIT_TRIGGERS = [
  "add",
  "apply",
  "build",
  "change",
  "create",
  "debug",
  "delete",
  "edit",
  "fix",
  "generate",
  "implement",
  "install",
  "modify",
  "move",
  "patch",
  "refactor",
  "remove",
  "rename",
  "repair",
  "replace",
  "resolve",
  "run",
  "scaffold",
  "test",
  "update",
  "write",
] as const;

/**
 * The router's question-and-chat vocabulary — `QUESTION_OR_CHAT_RE`'s
 * alternatives. That pattern is anchored at the start of the input, so these are
 * only a trigger in leading position, which is why `draftAndMode` places them
 * there rather than sprinkling them through the draft.
 */
export const RETIRED_ROUTER_QUESTION_TRIGGERS = [
  "hi",
  "hello",
  "hey",
  "yo",
  "thanks",
  "thank you",
  "what",
  "why",
  "how",
  "where",
  "when",
  "who",
  "which",
  "can you explain",
  "could you explain",
  "explain",
  "summarise",
  "summarize",
  "tell me",
] as const;

/** Both halves of the retired router's trigger vocabulary. */
export const RETIRED_ROUTER_TRIGGERS = [
  ...RETIRED_ROUTER_EDIT_TRIGGERS,
  ...RETIRED_ROUTER_QUESTION_TRIGGERS,
] as const;

/** Neutral words, so a draft is not a bare keyword list. */
const DRAFT_FILLER = ["the", "this", "file", "code", "for", "me", "again"] as const;

/**
 * A composer draft seeded with the retired router's trigger vocabulary.
 *
 * All three of the router's decision paths are reachable: a leading
 * question-or-chat word, an edit-intent word anywhere in the body, and a
 * trailing question mark. Seeding with exactly those words is the point — a
 * draft drawn from a neutral alphabet cannot detect a resurrected router, which
 * is the only thing Property 75 is looking for.
 *
 * Never empty and never whitespace-only, so every draw is a submittable draft
 * and the property never has to skip a case for a reason unrelated to mode.
 */
const composerDraft: fc.Arbitrary<string> = fc
  .tuple(
    fc.option(fc.constantFrom(...RETIRED_ROUTER_QUESTION_TRIGGERS), { nil: null }),
    fc.array(fc.constantFrom(...RETIRED_ROUTER_TRIGGERS), { minLength: 1, maxLength: 4 }),
    fc.array(fc.constantFrom(...DRAFT_FILLER), { maxLength: 4 }),
    fc.boolean(),
  )
  .map(([lead, triggers, filler, trailingQuestion]) => {
    const words = [...(lead === null ? [] : [lead]), ...triggers, ...filler];
    return `${words.join(" ")}${trailingQuestion ? "?" : ""}`;
  });

/**
 * A composer draft paired with an explicitly selected Conversation_Mode.
 *
 * The Permission_Mode axis is deliberately absent: Property 76 enumerates all
 * nine mode combinations exhaustively rather than sampling them, so there is
 * nothing here for a generator to draw. `PERMISSION_MODES` above is the list
 * that enumeration takes its product over.
 */
export const draftAndMode: fc.Arbitrary<[string, ConversationMode]> = fc.tuple(
  composerDraft,
  fc.constantFrom(...CONVERSATION_MODES),
);
