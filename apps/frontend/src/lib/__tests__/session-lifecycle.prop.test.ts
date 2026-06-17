// Feature: chat-memory-session-system, Property 6: A fresh session never auto-resumes a prior session
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type LifecycleInput,
  type LifecycleTrigger,
  resolveSessionIntent,
} from "../session-lifecycle";
import { arbId, arbSessionsUniqueIds } from "../../__tests__/arbitraries";

describe("session-lifecycle", () => {
  // Property 6: A fresh session never auto-resumes a prior session
  // Validates: Requirements 2.1
  it("Property 6: new-chat always resolves to fresh, regardless of sessions or lastActiveId", () => {
    fc.assert(
      fc.property(
        arbSessionsUniqueIds,
        // lastActiveId may be unset, an existing session id, or an arbitrary id.
        fc.option(fc.hexaString({ minLength: 1, maxLength: 8 }), { nil: null }),
        (sessions, lastActiveId) => {
          // Bias lastActiveId toward an existing session half the time so the
          // "even if a valid pointer exists" case is exercised.
          const pointer =
            sessions.length > 0 && lastActiveId != null && lastActiveId.length % 2 === 0
              ? sessions[lastActiveId.length % sessions.length].id
              : lastActiveId;

          const intent = resolveSessionIntent({
            trigger: "new-chat",
            sessions,
            lastActiveId: pointer,
          });

          expect(intent.kind).toBe("fresh");
        },
      ),
      { numRuns: 300 },
    );
  });
});

// Feature: chat-memory-session-system, Property 7: Resume only on explicit existing pointer
const TRIGGERS: LifecycleTrigger[] = [
  "app-open",
  "new-chat",
  "select",
  "delete-active",
];

/**
 * A lifecycle input over the full trigger/session/pointer space. `lastActiveId`
 * (and `selectedId`) draw from existing ids, fresh random ids that may not be
 * present, or `null`, so the generator covers the "names an existing session",
 * "names a missing session", and "unset" cases for the resume decision.
 */
const arbLifecycleInput: fc.Arbitrary<LifecycleInput> = arbSessionsUniqueIds.chain(
  (sessions) => {
    const ids = sessions.map((s) => s.id);
    const arbPointer = fc.oneof(
      fc.constant(null),
      arbId,
      ids.length > 0 ? fc.constantFrom(...ids) : fc.constant(null),
    );
    return fc.record({
      trigger: fc.constantFrom(...TRIGGERS),
      sessions: fc.constant(sessions),
      lastActiveId: arbPointer,
      selectedId: arbPointer,
    });
  },
);

describe("session-lifecycle: Property 7 (resume only on explicit existing pointer)", () => {
  // Property 7: Resume only on explicit existing pointer
  // Validates: Requirements 2.2
  it("a resume result implies app-open with an existing lastActiveId", () => {
    fc.assert(
      fc.property(arbLifecycleInput, (input) => {
        const intent = resolveSessionIntent(input);

        if (intent.kind === "resume") {
          // resume ⟹ trigger was app-open
          expect(input.trigger).toBe("app-open");
          // resume ⟹ lastActiveId names a session present in the list
          const named = input.sessions.some((s) => s.id === input.lastActiveId);
          expect(named).toBe(true);
          // the resumed session is exactly the pointer
          expect(intent.sessionId).toBe(input.lastActiveId);
        }
      }),
      { numRuns: 300 },
    );
  });

  // Property 7 (contrapositive): app-open without an existing pointer yields fresh.
  // Validates: Requirements 2.2
  it("app-open yields fresh when lastActiveId is unset or names no session", () => {
    fc.assert(
      fc.property(arbLifecycleInput, (input) => {
        const named =
          input.lastActiveId != null &&
          input.sessions.some((s) => s.id === input.lastActiveId);

        if (input.trigger === "app-open" && !named) {
          expect(resolveSessionIntent(input).kind).toBe("fresh");
        }
      }),
      { numRuns: 300 },
    );
  });
});
