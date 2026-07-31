/**
 * Property 3: An unrecognized discriminant is inert. R7.6.
 *
 * *For any* Message_Part sequence containing any number of parts with discriminants outside the
 * declared union, every part with a recognized discriminant renders exactly as it would without the
 * unknown parts, one neutral placeholder row renders per unknown part, the stream continues to
 * completion, and the number of log records equals the number of *distinct* unknown discriminants.
 *
 * ## Asserted against the real factory, which is why it lands after 17.1 rather than with 16.3
 *
 * The clause "renders exactly as it would without the unknown parts" is a claim about the row
 * factory's `switch`. A test that defined its own factory in order to check it would be agreeing
 * with itself — the same objection 15.5 records about deriving an expected fence count from the
 * function under test — so the property waited for `transcript-model.ts` to exist.
 *
 * ## Two things the property's wording leaves to the test, and the decisions taken
 *
 * **"Exactly as it would" is compared with row ids stripped.** A row id is `${messageId}:${index}`,
 * so deleting the unknown parts shifts every later index — the ids *must* differ and comparing them
 * would assert the opposite of the property. What is compared is each row's kind and content, in
 * order, which is the claim: the unknown parts changed nothing about the rows around them.
 *
 * **"The stream continues to completion" is asserted by rendering the whole sequence**, not by
 * checking a status flag. The failure this rules out is a `switch` that throws on the part it does
 * not know, taking the transcript down with it — so the assertion is that every recognized row is on
 * screen *after* the unknown ones have been rendered beside them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { TranscriptRowView } from "@/features/chat/TranscriptRowView";
import { rowsOfMessage, type TranscriptRow } from "@/features/chat/transcript-model";
import { logUnknownPart, resetUnknownPartLog } from "@/features/chat/unknown-parts";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

const RUNS = { numRuns: 100 } as const;
const RENDER_RUNS = { numRuns: 25 } as const;

type Part = ZocUIMessage["parts"][number];

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetUnknownPartLog();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  warn.mockRestore();
  resetUnknownPartLog();
});

// ── Generators ────────────────────────────────────────────────────────

const metadata = (): ZocUIMessage["metadata"] => ({
  runId: "run_1",
  provider: "anthropic",
  model: "claude-opus-5",
  conversationMode: "agent",
  startedAt: "2026-07-31T10:00:00.000Z",
  finishedAt: null,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCostCents: null,
  tokensPerSecond: null,
  messagesInContext: 1,
  sessionMessageCount: 1,
  messagesOutOfWindow: 0,
  summaryActive: false,
  rulesSources: [],
});

/** Every part shape the factory has an arm for, which is what "recognized" means here. */
const recognizedPart: fc.Arbitrary<Part> = fc.oneof(
  fc.record({
    type: fc.constant("text" as const),
    text: fc.string({ minLength: 1, maxLength: 40 }),
  }),
  fc.record({
    type: fc.constant("reasoning" as const),
    text: fc.string({ minLength: 1, maxLength: 40 }),
  }),
  fc.record({
    type: fc.constant("tool-workspace_read" as const),
    toolCallId: fc.stringMatching(/^call_[a-z0-9]{4}$/),
    state: fc.constant("output-available" as const),
    input: fc.constant({ path: "src/a.ts" }),
    output: fc.constant("ok"),
  }),
  fc.record({
    type: fc.constant("data-zoc-compaction" as const),
    id: fc.stringMatching(/^cmp_[a-z0-9]{4}$/),
    data: fc.record({
      type: fc.constant("compaction" as const),
      seq: fc.integer({ min: 1, max: 99 }),
      runId: fc.constant("run_1"),
      messageId: fc.constant("msg_1"),
      ts: fc.constant("2026-07-31T10:00:00.000Z"),
      compactionId: fc.stringMatching(/^cmp_[a-z0-9]{4}$/),
      foldedMessageIds: fc.array(fc.stringMatching(/^msg_[a-z0-9]{3}$/), { maxLength: 3 }),
      foldedTurnCount: fc.integer({ min: 1, max: 9 }),
      contextTokensBefore: fc.integer({ min: 1000, max: 99_000 }),
      contextTokensAfter: fc.integer({ min: 100, max: 999 }),
      summary: fc.string({ maxLength: 40 }),
    }),
  }),
  fc.record({
    type: fc.constant("data-zoc-error" as const),
    id: fc.constant("err_1"),
    data: fc.record({
      type: fc.constant("error" as const),
      seq: fc.integer({ min: 1, max: 99 }),
      runId: fc.constant("run_1"),
      messageId: fc.constant("msg_1"),
      ts: fc.constant("2026-07-31T10:00:00.000Z"),
      code: fc.constantFrom("provider_rate_limited", "workspace_unavailable"),
      message: fc.constant("Something recoverable happened."),
      details: fc.constant(null),
      retryable: fc.boolean(),
    }),
  }),
  // Recognized and drawn by nothing in M1. It must not log and must not become a placeholder.
  fc.record({ type: fc.constant("step-start" as const) }),
) as fc.Arbitrary<Part>;

/**
 * Discriminants outside the declared union.
 *
 * `custom` and `openai.compaction` are the realistic ones and the reason the property matters: the
 * design records that a provider emitting its own `custom` compaction part reaches the surface here,
 * and that rendering it through the placeholder path is the *correct* outcome.
 */
const UNKNOWN_DISCRIMINANTS = [
  "custom",
  "openai.compaction",
  "data-zoc-telepathy",
  "data-provider-thing",
  "tool_approval",
] as const;

const unknownPart: fc.Arbitrary<Part> = fc
  .constantFrom(...UNKNOWN_DISCRIMINANTS)
  .map((type) => ({ type, data: { note: "from a newer runtime" } }) as unknown as Part);

/** A sequence with unknown parts interleaved, and the same sequence with them removed. */
const interleaved = fc
  .array(
    fc.oneof({ weight: 3, arbitrary: recognizedPart }, { weight: 1, arbitrary: unknownPart }),
    {
      minLength: 1,
      maxLength: 14,
    },
  )
  .filter((parts) => parts.some((part) => isUnknown(part)));

function isUnknown(part: Part): boolean {
  return (UNKNOWN_DISCRIMINANTS as readonly string[]).includes(part.type);
}

function messageOf(parts: readonly Part[], id = "msg_1"): ZocUIMessage {
  return { id, role: "assistant", metadata: metadata(), parts: [...parts] } as ZocUIMessage;
}

/** A row without its position, which is what "renders exactly as it would" is a claim about. */
function contentOf(row: TranscriptRow): unknown {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "id"));
}

function mount(rows: readonly TranscriptRow[]) {
  return render(
    <ChatMotionProvider budget={null}>
      <div>
        {rows.map((row) => (
          <TranscriptRowView key={row.id} row={row} />
        ))}
      </div>
    </ChatMotionProvider>,
  );
}

// ── Property 3 ────────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 3: an unrecognized discriminant is inert", () => {
  it("emits exactly one placeholder row per unknown part, naming its discriminant (R7.6)", () => {
    fc.assert(
      fc.property(interleaved, (parts) => {
        resetUnknownPartLog();
        const rows = rowsOfMessage(messageOf(parts));
        const placeholders = rows.filter((row) => row.kind === "unknown");
        const unknowns = parts.filter(isUnknown);

        expect(placeholders).toHaveLength(unknowns.length);
        expect(placeholders.map((row) => (row.kind === "unknown" ? row.discriminant : ""))).toEqual(
          unknowns.map((part) => part.type),
        );
      }),
      RUNS,
    );
  });

  it("leaves every recognized part's row exactly as it would be without the unknown parts", () => {
    fc.assert(
      fc.property(interleaved, (parts) => {
        resetUnknownPartLog();
        const withUnknowns = rowsOfMessage(messageOf(parts));
        const without = rowsOfMessage(messageOf(parts.filter((part) => !isUnknown(part))));

        const recognized = withUnknowns.filter((row) => row.kind !== "unknown");
        expect(recognized.map(contentOf)).toEqual(without.map(contentOf));
      }),
      RUNS,
    );
  });

  /**
   * The property found a real conflict between two of its own clauses, and this is where it is
   * resolved. "Every recognized part renders exactly as it would" and "each placeholder sits exactly
   * where its part arrived" cannot both hold when the unknown part lands *inside* a run of tool
   * calls: consecutive same-timeline calls are one row, so a placeholder that split them would change
   * one recognized row into two. Inertness wins — R7.6 is a guarantee about not disturbing the
   * stream, and a part nobody can interpret has no meaningful position to defend — so the placeholder
   * is emitted immediately after the timeline it interrupted.
   */
  it("emits a placeholder after the timeline it landed inside, rather than splitting it", () => {
    resetUnknownPartLog();
    const tool = (id: string): Part =>
      ({
        type: "tool-workspace_read",
        toolCallId: id,
        state: "output-available",
        input: { path: "src/a.ts" },
        output: "ok",
      }) as unknown as Part;

    const rows = rowsOfMessage(
      messageOf([tool("call_a"), { type: "custom", data: {} } as unknown as Part, tool("call_b")]),
    );
    expect(rows.map((row) => row.kind)).toEqual(["tools", "unknown"]);
    // One timeline holding both calls, which is what a run of two same-tool calls is without the
    // unknown part in the middle.
    expect(rows[0]?.kind === "tools" ? rows[0].entries.map((e) => e.toolCallId) : []).toEqual([
      "call_a",
      "call_b",
    ]);
  });

  it("keeps a placeholder in place when no timeline is open around it", () => {
    resetUnknownPartLog();
    const rows = rowsOfMessage(
      messageOf([
        { type: "text", text: "before" } as Part,
        { type: "custom", data: {} } as unknown as Part,
        { type: "text", text: "after" } as Part,
      ]),
    );
    expect(rows.map((row) => row.kind)).toEqual(["answer", "unknown", "answer"]);
  });

  it("never lets an invisible part split a timeline, which `step-start` would do per step", () => {
    resetUnknownPartLog();
    const tool = (id: string): Part =>
      ({
        type: "tool-workspace_read",
        toolCallId: id,
        state: "output-available",
      }) as unknown as Part;
    const rows = rowsOfMessage(
      messageOf([tool("call_a"), { type: "step-start" } as Part, tool("call_b")]),
    );
    expect(rows.map((row) => row.kind)).toEqual(["tools"]);
  });

  it("logs once per distinct unknown discriminant, however many times each arrives (R7.6)", () => {
    fc.assert(
      fc.property(interleaved, (parts) => {
        resetUnknownPartLog();
        warn.mockClear();

        // Twice, because "once per Run" has to survive a re-render — which is exactly what a
        // virtualiser scrolling a row out of view and back produces.
        rowsOfMessage(messageOf(parts));
        rowsOfMessage(messageOf(parts));

        const distinct = new Set(parts.filter(isUnknown).map((part) => part.type));
        expect(warn).toHaveBeenCalledTimes(distinct.size);
      }),
      RUNS,
    );
  });

  it("logs per Run, so a second Run reports the same discriminant again", () => {
    resetUnknownPartLog();
    warn.mockClear();
    expect(logUnknownPart("run_1", "custom")).toBe(true);
    expect(logUnknownPart("run_1", "custom")).toBe(false);
    expect(logUnknownPart("run_2", "custom")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("renders every recognized row beside the placeholders rather than failing (R7.6)", () => {
    fc.assert(
      fc.property(interleaved, (parts) => {
        resetUnknownPartLog();
        const rows = rowsOfMessage(messageOf(parts));
        const { container, unmount } = mount(rows);

        try {
          // The stream reached completion: every row the factory produced is on screen, unknown
          // rows included, and nothing threw on the way.
          expect(container.querySelectorAll("[data-zoc-row='unknown']")).toHaveLength(
            rows.filter((row) => row.kind === "unknown").length,
          );
          for (const row of rows) {
            if (row.kind === "unknown") {
              expect(
                container.querySelector(`[data-zoc-unknown-discriminant="${row.discriminant}"]`),
              ).not.toBeNull();
            }
          }
          expect(container.querySelectorAll("[data-zoc-row='compaction']")).toHaveLength(
            rows.filter((row) => row.kind === "compaction").length,
          );
          expect(container.querySelectorAll("[data-zoc-row='usage']")).toHaveLength(
            rows.filter((row) => row.kind === "usage").length,
          );
        } finally {
          unmount();
        }
      }),
      RENDER_RUNS,
    );
  });

  it("makes a placeholder inert: nothing to click, and not drawn as a failure", () => {
    fc.assert(
      fc.property(fc.constantFrom(...UNKNOWN_DISCRIMINANTS), (discriminant) => {
        resetUnknownPartLog();
        const rows = rowsOfMessage(
          messageOf([{ type: discriminant, data: {} } as unknown as Part]),
        );
        const { container, unmount } = mount(rows);
        try {
          const placeholder = container.querySelector("[data-zoc-row='unknown']");
          expect(placeholder).not.toBeNull();
          expect(placeholder?.querySelectorAll("button")).toHaveLength(0);
          expect(placeholder?.querySelectorAll("a")).toHaveLength(0);
          expect(placeholder?.innerHTML).not.toContain("--zoc-error");
        } finally {
          unmount();
        }
      }),
      RUNS,
    );
  });

  it("produces one row per row-producing part and nothing else", () => {
    fc.assert(
      fc.property(interleaved, (parts) => {
        resetUnknownPartLog();
        const rows = rowsOfMessage(messageOf(parts));
        const expected = parts.filter((_part, index) => producesARow(parts, index)).length;
        expect(rows).toHaveLength(expected);
      }),
      RUNS,
    );
  });

  it("treats a recognized-but-undrawn part as recognized: no placeholder and no log", () => {
    resetUnknownPartLog();
    warn.mockClear();
    const rows = rowsOfMessage(
      messageOf([
        { type: "step-start" } as Part,
        { type: "file", mediaType: "image/png", url: "data:," } as unknown as Part,
        { type: "source-url", sourceId: "s1", url: "https://example.test" } as unknown as Part,
      ]),
    );
    expect(rows).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * Whether the part at `index` contributes a row of its own — an independent model of the factory's
 * grouping rules, so the row-count assertion is a second opinion rather than a restatement.
 *
 * Three rules, each matching one of the factory's: the four invisible kinds contribute nothing; a
 * tool part contributes a row only when it *opens* a run, since the rest fold into it; and neither an
 * invisible part nor an unknown one closes a run, which is why the look-back skips both.
 */
function producesARow(parts: readonly Part[], index: number): boolean {
  const part = parts[index];
  if (part === undefined || isInvisible(part)) return false;
  if (!isTool(part)) return true;

  for (let back = index - 1; back >= 0; back -= 1) {
    const previous = parts[back] as Part;
    if (isInvisible(previous) || isUnknown(previous)) continue;
    return !isTool(previous);
  }
  return true;
}

function isTool(part: Part): boolean {
  return part.type === "dynamic-tool" || part.type.startsWith("tool-");
}

function isInvisible(part: Part): boolean {
  return (
    part.type === "step-start" ||
    part.type === "file" ||
    part.type === "source-url" ||
    part.type === "source-document"
  );
}
