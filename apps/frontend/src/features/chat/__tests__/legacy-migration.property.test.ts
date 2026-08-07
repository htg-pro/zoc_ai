/**
 * Properties 39, 40, and 41 — the legacy migration's three invariants. R23.1, R23.2, R23.4, R23.5.
 * Tasks 24.3, 24.4, 24.5.
 *
 * ## Why these are generated rather than enumerated
 *
 * `legacy-reader.test.ts` (24.6) walks every arm of the mapper with a hand-written record per kind.
 * That is the right shape for "does `thinking` become a `reasoning` part" and the wrong shape for the
 * three claims below, which are all *universal*: they quantify over records the reader has never
 * seen. The legacy store holds data written by versions of the app that no longer exist, so the input
 * is genuinely arbitrary — and a hand-written fixture can only ever assert that the cases someone
 * thought of are handled.
 *
 * So the generator deliberately produces **malformed** records alongside well-formed ones: missing
 * fields, wrong types, `null` where an object belongs, and values that are not objects at all. The
 * point is not that those are realistic; it is that "never fails" is only worth asserting against
 * input chosen to make it fail.
 *
 * ## Mutation log
 *
 * Each property was checked against a deliberate regression in `legacy-reader.ts`, because a
 * property test that asserts nothing passes exactly as loudly as one that asserts everything:
 *
 * | # | Regression                                          | Caught by                       |
 * |---|-----------------------------------------------------|---------------------------------|
 * | A | unknown kind returns `skipped` not `historical`     | P39 "nothing is silently dropped" |
 * | B | per-conversation `catch` rethrows                   | P40 both isolation cases        |
 * | C | `orderAndRenumber` renumbers the stored record      | P41 "leaves records unmutated"  |
 * | D | `seq` keeps the record's original value             | P39 "same sequence invariant"   |
 * | E | the timestamp sort is removed                       | P39 "orders by timestamp"       |
 *
 * A first version of this file **failed A**: it derived "what should be visible" from
 * `mapLegacyEvent`'s own verdict, so when the mapper's verdict changed, both sides of the comparison
 * moved together and the assertion stayed true. The fix is {@link TELEMETRY_ONLY} below — an oracle
 * copied from the spec rather than read out of the module under test.
 */

import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";

import {
  isUnreadable,
  mapLegacyEvent,
  orderAndRenumber,
  readLegacyConversation,
  readLegacyConversations,
  type LegacyConversationRef,
  type LegacyStore,
  type MigratedSession,
} from "@/features/chat/migration/legacy-reader";

// ── Generators ────────────────────────────────────────────────────────

/** Every kind the legacy contract declared. The reader must have an answer for all of them. */
const LEGACY_KINDS = [
  "intent",
  "thinking",
  "plan",
  "plan-update",
  "plan-ready",
  "map-files",
  "read-files",
  "context-compressed",
  "edit-file",
  "command",
  "review",
  "stage",
  "summary",
  "approval",
  "permission",
  "recovery-attempt",
  "budget",
  "test-results",
  "done",
] as const;

const timestamp = fc
  .integer({ min: Date.parse("2026-01-01T00:00:00Z"), max: Date.parse("2026-07-01T00:00:00Z") })
  .map((ms) => new Date(ms).toISOString());

/**
 * A record that names a real legacy kind but whose payload is arbitrary.
 *
 * The payload is generated *independently* of the kind on purpose: a `plan-ready` with no `steps`, an
 * `edit-file` with a numeric `path`, a `budget` whose `tokenLimit` is a string. Those are exactly the
 * shapes a partially-written or version-skewed record has, and they are the ones that turn a mapper
 * into a thrown `TypeError`.
 */
const wellNamedEvent = fc.record({
  type: fc.constantFrom(...LEGACY_KINDS),
  seq: fc.integer({ min: 0, max: 500 }),
  runId: fc.constantFrom("run_1", "run_2", "run_3"),
  ts: timestamp,
  // A scattering of the fields the various kinds read, each optional and each sometimes wrong.
  text: fc.option(fc.oneof(fc.string(), fc.integer()), { nil: undefined }),
  path: fc.option(fc.oneof(fc.string(), fc.constant(null)), { nil: undefined }),
  diff: fc.option(fc.string(), { nil: undefined }),
  steps: fc.option(fc.oneof(fc.array(fc.object()), fc.constant(null), fc.string()), {
    nil: undefined,
  }),
  files: fc.option(fc.oneof(fc.array(fc.object()), fc.constant(null)), { nil: undefined }),
  status: fc.option(fc.string(), { nil: undefined }),
  ok: fc.option(fc.boolean(), { nil: undefined }),
  effect: fc.option(fc.string(), { nil: undefined }),
  stage: fc.option(fc.string(), { nil: undefined }),
  command: fc.option(fc.string(), { nil: undefined }),
  tokensUsed: fc.option(fc.oneof(fc.integer(), fc.string()), { nil: undefined }),
  originalTokens: fc.option(fc.integer(), { nil: undefined }),
});

/** Records that are not legacy events at all — the version-skew and corruption cases. */
const junkRecord = fc.oneof(
  fc.constant(null),
  fc.constant(undefined),
  fc.integer(),
  fc.string(),
  fc.boolean(),
  fc.array(fc.string()),
  fc.object(),
  // A record that looks like an event but names a kind invented after this reader was written.
  fc.record({ type: fc.constantFrom("teleport", "quantum-merge"), seq: fc.nat(), ts: timestamp }),
);

/** Mostly plausible records, with junk mixed in often enough to actually exercise the fallbacks. */
const anyRecord: fc.Arbitrary<unknown> = fc.oneof(
  { arbitrary: wellNamedEvent as fc.Arbitrary<unknown>, weight: 4 },
  { arbitrary: junkRecord as fc.Arbitrary<unknown>, weight: 1 },
);

const eventLog = fc.array(anyRecord, { minLength: 0, maxLength: 40 });

const REF: LegacyConversationRef = {
  id: "c1",
  title: "Old",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function storeOf(events: readonly unknown[]): LegacyStore {
  return {
    listConversations: () => Promise.resolve([REF]),
    readEvents: () => Promise.resolve(events),
  };
}

/**
 * The only two kinds R23.2 permits the migration to make invisible: both are telemetry about an
 * event that already rendered, so replaying them would duplicate a row rather than add one.
 *
 * This list is **duplicated from the reader on purpose.** An oracle read out of the module under
 * test moves whenever that module moves — deriving "what should be visible" from `mapLegacyEvent`'s
 * own verdict makes the assertion true by construction, and a reader that started dropping whole
 * kinds would still pass. (Verified: it did. See the mutation note at the top of this file.)
 */
const TELEMETRY_ONLY: ReadonlySet<string> = new Set(["plan-update", "map-files"]);

function isTelemetryOnly(record: unknown): boolean {
  if (record === null || typeof record !== "object") return false;
  const type = (record as { type?: unknown }).type;
  return typeof type === "string" && TELEMETRY_ONLY.has(type);
}

// ── Property 39 ───────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 39: legacy events never fail the reader", () => {
  it("classifies any record into exactly one of the three outcomes, without throwing (R23.2)", () => {
    fc.assert(
      fc.property(anyRecord, fc.nat({ max: 1000 }), (record, seq) => {
        const result = mapLegacyEvent(record, { messageId: "m1", seq });
        expect(["mapped", "skipped", "historical"]).toContain(result.outcome);
        // A "mapped" outcome that produced nothing would be a turn silently deleted — the mapper
        // falls back to a historical row instead, so this can never be empty.
        if (result.outcome === "mapped") expect(result.parts.length).toBeGreaterThan(0);
      }),
      { numRuns: 400 },
    );
  });

  it("accounts for every input record — nothing is silently dropped (R23.2)", async () => {
    await fc.assert(
      fc.asyncProperty(eventLog, async (records) => {
        const result = await readLegacyConversation(storeOf(records), REF);
        // A log of pure junk is legitimately rejected wholesale; that is Property 40's territory.
        if (isUnreadable(result)) return;

        const session = result as MigratedSession;

        // Every record except the two documented telemetry kinds must reach the transcript, as one
        // or more parts or as a historical row. This is the claim R23.2 actually makes, and the
        // bound is what makes it checkable: a kind the reader stops understanding produces neither,
        // so the visible total falls below the number of records that were owed a place.
        const owed = records.filter((record) => !isTelemetryOnly(record)).length;
        expect(session.parts.length + session.historical.length).toBeGreaterThanOrEqual(owed);

        // And separately, the assembly loop must not lose a part the mapper built. This one *does*
        // consult the mapper, so it cannot catch a change of verdict — it catches the other bug:
        // a `continue` in the wrong branch, or a row written but never pushed.
        const outcomes = records.map((record) =>
          mapLegacyEvent(record, { messageId: "m", seq: 1 }),
        );
        expect(session.historical).toHaveLength(
          outcomes.filter((o) => o.outcome === "historical").length,
        );
        expect(session.parts).toHaveLength(
          outcomes.reduce((n, o) => n + (o.outcome === "mapped" ? o.parts.length : 0), 0),
        );
      }),
      { numRuns: 120 },
    );
  });

  it("gives a migrated Session the same sequence invariant as a new one (R23.2)", () => {
    fc.assert(
      fc.property(eventLog, (records) => {
        const ordered = orderAndRenumber(records);
        // 1..n, strictly increasing, no gaps — the invariant a Session written today satisfies. A
        // migrated Session that did not would break every consumer that trusts `seq` to order.
        expect(ordered.map((entry) => entry.seq)).toEqual(
          Array.from({ length: records.length }, (_, index) => index + 1),
        );
        // Renumbering is a permutation: no record is lost and none is duplicated.
        expect(ordered).toHaveLength(records.length);
      }),
      { numRuns: 150 },
    );
  });

  it("orders by timestamp regardless of the order the store returned them in (R23.2)", () => {
    fc.assert(
      fc.property(fc.array(wellNamedEvent, { minLength: 2, maxLength: 20 }), (records) => {
        const times = orderAndRenumber(records).map((entry) =>
          Date.parse(String((entry.record as { ts: string }).ts)),
        );
        for (let index = 1; index < times.length; index += 1) {
          expect(times[index - 1]).toBeLessThanOrEqual(times[index] as number);
        }
      }),
      { numRuns: 120 },
    );
  });
});

// ── Property 40 ───────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 40: an unreadable conversation is isolated", () => {
  it("keeps every readable conversation available when any subset fails (R23.4)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }), async (failures) => {
        const refs = failures.map((_, index) => ({
          id: `c${String(index)}`,
          title: `Conversation ${String(index)}`,
          updatedAt: "2026-07-01T10:00:00.000Z",
        }));

        const store: LegacyStore = {
          listConversations: () => Promise.resolve(refs),
          readEvents: (id) => {
            const index = Number(id.slice(1));
            return failures[index] === true
              ? Promise.reject(new TypeError("gone"))
              : Promise.resolve([
                  {
                    type: "summary",
                    text: "hi",
                    seq: 1,
                    runId: "r",
                    ts: "2026-07-01T10:00:00.000Z",
                  },
                ]);
          },
        };

        const { sessions, unreadable } = await readLegacyConversations(store);

        // The two lists partition the input: nothing is lost and nothing is counted twice.
        expect(sessions.length + unreadable.length).toBe(refs.length);
        expect(unreadable).toHaveLength(failures.filter(Boolean).length);
        // Every failure names a reason and carries a sentence to show (R23.4).
        for (const entry of unreadable) {
          expect(entry.reason).toBeTruthy();
          expect(entry.message.length).toBeGreaterThan(0);
        }
        // And every survivor is a fully-formed Session, not a husk.
        for (const session of sessions) {
          expect(session.parts.length).toBeGreaterThan(0);
        }
      }),
      { numRuns: 60 },
    );
  });

  it("never throws out of the read, whatever the store does (R23.4)", async () => {
    const thrown = fc.oneof(
      fc.constant(new TypeError("network")),
      fc.constant(new SyntaxError("bad json")),
      fc.constant(new Error("unknown")),
      // A rejection that is not an `Error` at all, which a `catch (e) { e.message }` would break on.
      fc.constant("a bare string"),
      fc.constant(null),
    );

    await fc.assert(
      fc.asyncProperty(thrown, async (cause) => {
        const store: LegacyStore = {
          listConversations: () => Promise.resolve([REF]),
          readEvents: () => Promise.reject(cause),
        };
        const result = await readLegacyConversation(store, REF);
        expect(isUnreadable(result)).toBe(true);
      }),
      { numRuns: 40 },
    );
  });

  it("reports a partially readable conversation with the skipped count, not as a failure (R23.4)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(junkRecord, { minLength: 1, maxLength: 6 }),
        fc.array(
          fc.record({
            type: fc.constant("summary"),
            text: fc.string({ minLength: 1 }),
            seq: fc.nat({ max: 50 }),
            runId: fc.constant("r"),
            ts: timestamp,
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (junk, good) => {
          const result = await readLegacyConversation(storeOf([...junk, ...good]), REF);
          // At least one turn is readable, so the conversation is a Session — the mappable turns
          // render and one card names what was skipped, rather than the whole thing being lost.
          expect(isUnreadable(result)).toBe(false);
          const session = result as MigratedSession;
          expect(session.parts.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 60 },
    );
  });
});

// ── Property 41 ───────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 41: writing a new Session does not disturb stored history", () => {
  it("never invokes anything but the two read methods (R23.5)", async () => {
    await fc.assert(
      fc.asyncProperty(eventLog, async (records) => {
        const writes = {
          writeEvents: vi.fn(),
          appendEvent: vi.fn(),
          deleteConversation: vi.fn(),
          updateConversation: vi.fn(),
          save: vi.fn(),
        };
        const store = {
          listConversations: vi.fn(() => Promise.resolve([REF])),
          readEvents: vi.fn(() => Promise.resolve(records)),
          ...writes,
        };

        await readLegacyConversations(store as unknown as LegacyStore);

        for (const spy of Object.values(writes)) {
          expect(spy).not.toHaveBeenCalled();
        }
      }),
      { numRuns: 50 },
    );
  });

  it("leaves the stored records themselves unmutated (R23.5)", async () => {
    await fc.assert(
      fc.asyncProperty(eventLog, async (records) => {
        // The reader keeps the original record on every historical row (`raw`), so a mapper that
        // normalised in place would corrupt the very evidence the row exists to preserve.
        const before = JSON.stringify(records);
        await readLegacyConversation(storeOf(records), REF);
        expect(JSON.stringify(records)).toBe(before);
      }),
      { numRuns: 80 },
    );
  });

  it("is idempotent: reading twice yields the same Session (R23.5)", async () => {
    await fc.assert(
      fc.asyncProperty(eventLog, async (records) => {
        const store = storeOf(records);
        const first = await readLegacyConversation(store, REF);
        const second = await readLegacyConversation(store, REF);
        // Equality here is the observable proof that the first read changed nothing — neither the
        // store nor any hidden cursor inside the reader.
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      }),
      { numRuns: 60 },
    );
  });
});
