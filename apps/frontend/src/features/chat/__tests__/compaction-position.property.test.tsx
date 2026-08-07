/**
 * Property 81: A Compaction_Record round-trips into its original transcript position —
 * zoc-agent-chat-rebuild R34.3, R34.6, task 22.16.
 *
 * *For any* transcript containing any number of Compaction_Records at arbitrary positions, persisting
 * the Session and restoring it yields a part list equal to the original when ordered by sequence number,
 * with every Compaction_Record at the same index it occupied before — between the last folded turn and
 * the first retained one — and every folded turn still present and still expandable.
 *
 * ## Why the round trip is `JSON` rather than a faked client
 *
 * The gateway stores a transcript as **opaque JSON**: `transcripts.py` validates the envelope (`id`,
 * `role`, `parts`) and preserves everything else byte-for-byte, by design — the AI SDK part union has no
 * Python mirror (R2.2). So the wire is `JSON.stringify` on the way out and `JSON.parse` plus
 * `restoreTranscript`'s boundary check on the way in, and a test that faked a client would be asserting
 * against its own fake's fidelity instead of against the two functions that actually transform anything.
 * The HTTP half has its own coverage; what is unasserted without this file is *position*.
 *
 * ## The three claims are asserted separately on purpose
 *
 * Deep equality of the restored transcript would seem to subsume the rest, and it nearly does — but it
 * would pass for a transcript whose compaction rows had been re-ordered *identically* on both sides of
 * the round trip, which is exactly the bug a later "sort the parts on restore" change would introduce.
 * So index equality is asserted against the *positions the fixture chose*, recomputed from
 * `foldedMessageIds` rather than from the array the round trip produced.
 *
 * ## Why `sessionHistory`
 *
 * Task 22.16 names it, and the reason is that its 0–4 folds at arbitrary positions over 0–120 messages
 * are precisely this property's domain — including the case that matters most and reads as an oversight
 * in a hand-written fixture: a transcript that has **never** compacted must round-trip too.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";
import type { CompactionPart } from "@zoc-studio/shared-types";

import { CompactionRow } from "@/features/chat/CompactionRow";
import { restoreTranscript, wirePartsOf } from "@/features/chat/transcript-persistence";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { sessionHistory, type SessionFixture } from "./arbitraries";

afterEach(cleanup);

// ── The transcript a fixture describes ────────────────────────────────

/**
 * A `SessionFixture` as the transcript the renderer holds.
 *
 * Each stored `Message` becomes one message with a text part, and each fold becomes a message carrying a
 * `data-zoc-compaction` part **immediately after the last message it folds**. That placement is the
 * position the property is about: R34.3 puts the record between the last folded turn and the first
 * retained one, so the fixture's `afterMessageIndex` is where it goes in and where it has to come back.
 */
function transcriptOf(fixture: SessionFixture): ZocUIMessage[] {
  const byPosition = new Map<number, CompactionPart[]>();
  for (const fold of fixture.compactions) {
    const at = byPosition.get(fold.afterMessageIndex) ?? [];
    at.push(fold.part);
    byPosition.set(fold.afterMessageIndex, at);
  }

  const transcript: ZocUIMessage[] = [];
  fixture.session.messages.forEach((message, index) => {
    transcript.push({
      id: message.id,
      role: message.role === "user" ? "user" : "assistant",
      parts: [{ type: "text", text: message.content ?? "" }],
    } as ZocUIMessage);
    for (const part of byPosition.get(index) ?? []) {
      transcript.push({
        id: `cmp_msg_${part.compactionId}`,
        role: "assistant",
        parts: [{ type: "data-zoc-compaction", data: part }],
      } as ZocUIMessage);
    }
  });
  return transcript;
}

/** What the gateway does to a transcript: store the bytes, hand them back, check the envelope. */
function roundTrip(transcript: readonly ZocUIMessage[]): {
  readonly messages: readonly ZocUIMessage[];
  readonly skipped: number;
} {
  const stored = JSON.parse(JSON.stringify(transcript)) as readonly unknown[];
  return restoreTranscript(stored);
}

/** Every message index holding a Compaction_Record, paired with its `compactionId`. */
function compactionIndices(messages: readonly ZocUIMessage[]): Array<[number, string]> {
  const found: Array<[number, string]> = [];
  messages.forEach((message, index) => {
    for (const part of message.parts as ReadonlyArray<{ type: string; data?: CompactionPart }>) {
      if (part.type === "data-zoc-compaction" && part.data !== undefined) {
        found.push([index, part.data.compactionId]);
      }
    }
  });
  return found;
}

/** The wire parts that carry a `seq`, in sequence order — the ordering the property names. */
function partsBySeq(messages: readonly ZocUIMessage[]): unknown[] {
  return wirePartsOf(messages)
    .filter(
      (part): part is Record<string, unknown> & { seq: number } =>
        typeof part === "object" &&
        part !== null &&
        typeof (part as { seq?: unknown }).seq === "number",
    )
    .slice()
    .sort((left, right) => left.seq - right.seq);
}

describe("Feature: zoc-agent-chat-rebuild, task 22.16 — Property 81: Compaction_Record position", () => {
  it("restores every record at the index it occupied, with its folded turns intact (R34.3, R34.6)", () => {
    fc.assert(
      fc.property(sessionHistory, (fixture) => {
        const original = transcriptOf(fixture);
        const { messages: restored, skipped } = roundTrip(original);

        // Nothing was dropped at the boundary. Asserted first, because every claim below is about a
        // transcript that survived — a restore that skipped the compaction messages would otherwise make
        // the index comparison trivially true over an empty list.
        expect(skipped, "the boundary check rejected a record it wrote itself").toBe(0);
        expect(restored).toHaveLength(original.length);
        expect(restored).toEqual(original);

        // Claim 1: the part list ordered by sequence number is unchanged.
        expect(partsBySeq(restored)).toEqual(partsBySeq(original));

        // Claim 2: every record is at the same index, and that index is the one the fixture chose —
        // recomputed from the fold's own `foldedMessageIds` rather than read back off the round trip, so
        // a restore that re-ordered records consistently on both sides still fails.
        const before = compactionIndices(original);
        const after = compactionIndices(restored);
        expect(after).toEqual(before);
        expect(after).toHaveLength(fixture.compactions.length);

        for (const [index, compactionId] of after) {
          const fold = fixture.compactions.find(
            (entry) => entry.part.compactionId === compactionId,
          );
          expect(fold, `restored a record the fixture never wrote: ${compactionId}`).toBeDefined();
          const folded = fold?.part.foldedMessageIds ?? [];

          // Between the last folded turn and the first retained one.
          const previous = restored[index - 1];
          expect(
            previous,
            `a record at index ${String(index)} has nothing folded before it`,
          ).toBeDefined();
          expect(folded, "the record does not sit after the last turn it folds").toContain(
            previous?.id,
          );

          const next = restored[index + 1];
          if (next !== undefined && !next.id.startsWith("cmp_msg_")) {
            // The first retained turn: after the record, and not one of the folded ids.
            expect(folded, "the record swallowed the first retained turn").not.toContain(next.id);
          }

          // Claim 3a: every folded turn is still present.
          for (const id of folded) {
            expect(
              restored.some((message) => message.id === id),
              `folded turn ${id} is missing from the restored transcript`,
            ).toBe(true);
          }
        }
      }),
      { numRuns: 60 },
    );
  });

  it("keeps every restored record expandable, listing the turns it folded (R34.3)", () => {
    // Claim 3b, the rendered half: "still expandable" is a claim about the row, so it is asserted by
    // rendering one — and rendered from the **restored** part rather than the original, which is what
    // makes it a statement about the round trip rather than about the fixture.
    fc.assert(
      fc.property(sessionHistory, (fixture) => {
        const original = transcriptOf(fixture);
        const { messages: restored } = roundTrip(original);
        const titleOf = new Map(
          restored.map((message) => [
            message.id,
            (message.parts as ReadonlyArray<{ type: string; text?: string }>).find(
              (part) => part.type === "text",
            )?.text,
          ]),
        );

        for (const [index] of compactionIndices(restored)) {
          const part = (
            restored[index]?.parts as ReadonlyArray<{ type: string; data?: CompactionPart }>
          ).find((entry) => entry.type === "data-zoc-compaction")?.data;
          expect(part).toBeDefined();
          if (part === undefined) continue;

          const view = render(
            <CompactionRow compaction={part} resolveFoldedTurn={(id) => titleOf.get(id)} />,
          );
          const trigger = view.container.querySelector("[data-zoc-compaction-trigger]");
          expect(trigger, "a restored record is not expandable").not.toBeNull();

          fireEvent.click(trigger as HTMLElement);
          const turns = view.container.querySelectorAll("[data-zoc-compaction-turn]");
          expect(
            turns,
            `expanding listed ${String(turns.length)} of ${String(part.foldedMessageIds.length)} folded turns`,
          ).toHaveLength(part.foldedMessageIds.length);
          view.unmount();
        }
      }),
      // Lower than the pure property: this arm mounts up to four rows per case, and the claim it adds is
      // structural rather than value-dependent.
      { numRuns: 20 },
    );
  });

  it("round-trips a transcript that has never compacted", () => {
    // The case a hand-written fixture omits. It is in the generated domain above too; stated separately
    // because "no records" is the reading of "any number" that a reviewer will look for.
    const transcript: ZocUIMessage[] = [
      { id: "m_0", role: "user", parts: [{ type: "text", text: "turn 0" }] } as ZocUIMessage,
      { id: "m_1", role: "assistant", parts: [{ type: "text", text: "turn 1" }] } as ZocUIMessage,
    ];
    const { messages: restored, skipped } = roundTrip(transcript);
    expect(skipped).toBe(0);
    expect(restored).toEqual(transcript);
    expect(compactionIndices(restored)).toHaveLength(0);
  });
});
