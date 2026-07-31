/**
 * Properties 38, 87, 88, and 89 — the Session list's four claims. R15.5, R15.8, R15.9, R15.10, R15.11.
 *
 * **Property 38 — search is sound and complete.** *For any* Session set and *any* query, the result contains
 * every Session whose title or message text contains the query and no Session that does not.
 *
 * **Property 87 — fork and duplicate leave the source Session unchanged.** *For any* Session and *any* fork
 * point, the source is byte-identical afterwards — and stays byte-identical after the copy is itself
 * mutated, which is the clause a happy-path test misses.
 *
 * **Property 88 — workspace scoping lists exactly the matching Sessions.** *For any* Session set and *any*
 * root, the list contains every Session bound to that root and no other — where "bound to" ignores a
 * trailing separator and case, because the same folder reaches the surface spelled several ways.
 *
 * **Property 89 — archiving partitions the list and preserves the transcript.** *For any* Session,
 * archiving removes it from the default list, puts it in the archived one, and changes not one message.
 *
 * ## Why 87's second clause is the whole property
 *
 * `forkSession` returning a new object passes an immediate comparison while still sharing the *message
 * array* with its source. The bug then appears one action later: appending to the fork appends to the
 * source, and the user reads it as their history rewriting itself. So the property mutates the copy and
 * re-compares — which is the only ordering in which a shared array is visible.
 *
 * ## Why 88 generates dirty roots
 *
 * `workspaceRoot` draws `/work/proj`, `/Work/Proj`, and `/work/proj//` on purpose. A scoping implementation
 * that compares raw strings passes against a clean alphabet and fails only on those pairs — and its failure
 * mode is a user's Sessions silently missing from their own workspace, with no error anywhere.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { sessionHistory, workspaceRoot } from "@/features/chat/__tests__/arbitraries";
import {
  ARCHIVED_STATUS,
  archiveSession,
  canonicalRoot,
  duplicateSession,
  forkSession,
  isArchived,
  partitionByStatus,
  scopeToWorkspace,
  searchSessions,
  sessionRows,
  titleFromFirstMessage,
  unarchiveSession,
} from "@/features/sessions/session-list-model";
import type { Session } from "@zoc-studio/shared-types";

const RUNS = { numRuns: 200 } as const;

/** A Session set drawn from the shared fixture, ids made unique. */
const sessions = fc
  .array(sessionHistory, { minLength: 1, maxLength: 8 })
  .map((fixtures) =>
    fixtures.map((fixture, index) => ({
      ...fixture.session,
      id: `${fixture.session.id}_${String(index)}`,
    })),
  );

const NOW = "2026-07-31T10:00:00.000Z";

describe("Feature: zoc-agent-chat-rebuild, Property 38: session search is sound and complete", () => {
  it("returns exactly the Sessions whose title or messages contain the query (R15.5)", () => {
    fc.assert(
      fc.property(sessions, fc.string({ maxLength: 6 }), (pool, query) => {
        const hits = searchSessions(pool, query);
        const returned = new Set(hits.map((hit) => hit.session.id));
        const needle = query.trim().toLowerCase();

        for (const session of pool) {
          const matches =
            needle.length === 0 ||
            session.title.toLowerCase().includes(needle) ||
            session.messages.some((message) => message.content.toLowerCase().includes(needle));
          // Sound *and* complete, as one assertion per Session: membership is exactly the predicate.
          expect(returned.has(session.id), `${session.id} for "${query}"`).toBe(matches);
        }
      }),
      RUNS,
    );
  });

  it("reports which messages matched, in transcript order", () => {
    fc.assert(
      fc.property(sessions, fc.constantFrom("turn", "turn 1", "TURN"), (pool, query) => {
        for (const hit of searchSessions(pool, query)) {
          const order = hit.session.messages.map((message) => message.id);
          const positions = hit.matchedMessageIds.map((id) => order.indexOf(id));
          expect(positions.every((position) => position >= 0)).toBe(true);
          // Transcript order, so a later "3 matches, jump to the first" affordance has somewhere to jump.
          expect([...positions].sort((a, b) => a - b)).toEqual(positions);
        }
      }),
      RUNS,
    );
  });

  it("restores the whole list when the query is cleared", () => {
    fc.assert(
      fc.property(sessions, (pool) => {
        // An empty query matching nothing would make clearing the box look like deleting the Sessions.
        expect(searchSessions(pool, "").length).toBe(pool.length);
        expect(searchSessions(pool, "   ").length).toBe(pool.length);
      }),
      RUNS,
    );
  });

  it("finds a phrase in a Session's message text and not in its neighbour's", () => {
    // A worked example beside the property, because "sound and complete" over generated text can hold
    // while the search reads the wrong field.
    const base: Session = {
      id: "s1",
      title: "Refactor auth",
      status: "idle",
      workspace_root: "/work/proj",
      provider: null,
      model: null,
      created_at: NOW,
      updated_at: NOW,
      messages: [
        { id: "m0", role: "user", content: "please fix the token helper", created_at: NOW },
        { id: "m1", role: "assistant", content: "done", created_at: NOW },
      ],
      plan: null,
      tool_calls: [],
    };
    const other: Session = { ...base, id: "s2", title: "Something else", messages: [] };

    const hits = searchSessions([base, other], "token helper");
    expect(hits.map((hit) => hit.session.id)).toEqual(["s1"]);
    expect(hits[0]?.matchedMessageIds).toEqual(["m0"]);
    expect(hits[0]?.matchedTitle).toBe(false);
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 87: fork and duplicate leave the source Session unchanged", () => {
  it("leaves the source byte-identical, before and after the copy is mutated (R15.8, R15.9)", () => {
    fc.assert(
      fc.property(sessionHistory, fc.nat({ max: 130 }), (fixture, at) => {
        const source = fixture.session;
        const before = JSON.stringify(source);

        const fork = forkSession(source, at % Math.max(1, source.messages.length + 1), {
          id: "sess_fork",
          now: NOW,
        });
        expect(JSON.stringify(source)).toBe(before);

        // The clause a happy-path test misses: a copy sharing its source's message array passes the
        // comparison above and fails here.
        fork.messages.push({
          id: "appended",
          role: "user",
          content: "a new turn in the fork",
          created_at: NOW,
        });
        fork.title = "renamed in the fork";
        expect(JSON.stringify(source)).toBe(before);

        const copy = duplicateSession(source, { id: "sess_copy", now: NOW });
        expect(JSON.stringify(source)).toBe(before);
        copy.messages.push({ id: "also", role: "user", content: "and here", created_at: NOW });
        expect(JSON.stringify(source)).toBe(before);
      }),
      RUNS,
    );
  });

  it("forks the prefix through the chosen message, inclusive", () => {
    fc.assert(
      fc.property(
        sessionHistory.filter((fixture) => fixture.session.messages.length > 0),
        fc.nat(),
        (fixture, pick) => {
          const source = fixture.session;
          const at = pick % source.messages.length;
          const fork = forkSession(source, at, { id: "sess_fork", now: NOW });

          expect(fork.messages.length).toBe(at + 1);
          expect(fork.messages.map((message) => message.id)).toEqual(
            source.messages.slice(0, at + 1).map((message) => message.id),
          );
          // A new identity, a fresh clock, and an open status: a fork is a Session the user continues.
          expect(fork.id).toBe("sess_fork");
          expect(fork.created_at).toBe(NOW);
          expect(fork.status).toBe("active");
        },
      ),
      RUNS,
    );
  });

  it("duplicates the whole transcript, which is a fork at the last message (R15.9)", () => {
    fc.assert(
      fc.property(sessionHistory, (fixture) => {
        const source = fixture.session;
        const copy = duplicateSession(source, { id: "sess_copy", now: NOW });
        expect(copy.messages.map((message) => message.id)).toEqual(
          source.messages.map((message) => message.id),
        );
        // Named so the two are distinguishable in a list where every other fact is the same.
        expect(copy.title).toBe(`${source.title} (copy)`);
      }),
      RUNS,
    );
  });

  it("titles a fork from its own first user message", () => {
    fc.assert(
      fc.property(
        sessionHistory.filter((fixture) => fixture.session.messages.length > 1),
        (fixture) => {
          const fork = forkSession(fixture.session, 0, { id: "sess_fork", now: NOW });
          expect(fork.title).toBe(titleFromFirstMessage(fork.messages));
        },
      ),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 88: workspace scoping lists exactly the matching Sessions", () => {
  it("ignores a trailing separator and case when comparing roots (R15.10)", () => {
    fc.assert(
      fc.property(sessions, workspaceRoot, (pool, root) => {
        const scoped = scopeToWorkspace(pool, root);
        const listed = new Set(scoped.map((session) => session.id));

        for (const session of pool) {
          const belongs = canonicalRoot(session.workspace_root ?? "") === canonicalRoot(root);
          expect(listed.has(session.id), `${session.workspace_root} against ${root}`).toBe(belongs);
        }
      }),
      RUNS,
    );
  });

  it("treats the spellings of one folder as one folder", () => {
    // The pairs a raw-string comparison gets wrong, written out: this is the failure the generator's
    // variants exist to catch, and its user-visible form is Sessions missing from their own workspace.
    for (const [a, b] of [
      ["/work/proj", "/work/proj/"],
      ["/work/proj", "/work/proj//"],
      ["/Work/Proj", "/work/proj"],
      ["/Users/dev/my-proj/", "/users/dev/my-proj"],
    ]) {
      expect(canonicalRoot(a)).toBe(canonicalRoot(b));
    }
  });

  it("scopes to nothing when no root is resolved", () => {
    fc.assert(
      fc.property(sessions, (pool) => {
        // Not to everything: an unresolved root means the surface does not know which workspace it is
        // looking at, and listing every Session would invite a user to open one against the wrong tree.
        expect(scopeToWorkspace(pool, null)).toEqual([]);
        expect(scopeToWorkspace(pool, "   ")).toEqual([]);
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 89: archiving partitions the list and preserves the transcript", () => {
  it("moves the Session between the two lists and changes no message (R15.11)", () => {
    fc.assert(
      fc.property(sessionHistory, (fixture) => {
        const source: Session = { ...fixture.session, status: "idle" };
        const transcript = JSON.stringify(source.messages);

        const archived = archiveSession(source, NOW);
        expect(archived.status).toBe(ARCHIVED_STATUS);
        expect(isArchived(archived)).toBe(true);
        // A status change, not a truncation: the whole reason the archived filter can show a Session with
        // everything still in it.
        expect(JSON.stringify(archived.messages)).toBe(transcript);

        const rowsOpen = sessionRows([archived], {
          workspaceRoot: source.workspace_root,
          filter: "open",
        });
        const rowsArchived = sessionRows([archived], {
          workspaceRoot: source.workspace_root,
          filter: "archived",
        });
        expect(rowsOpen.map((row) => row.id)).toEqual([]);
        expect(rowsArchived.map((row) => row.id)).toEqual([archived.id]);

        // And back, with the transcript still whole.
        const restored = unarchiveSession(archived, NOW);
        expect(isArchived(restored)).toBe(false);
        expect(JSON.stringify(restored.messages)).toBe(transcript);
      }),
      RUNS,
    );
  });

  it("puts every Session in exactly one half", () => {
    fc.assert(
      fc.property(sessions, (pool) => {
        const { open, archived } = partitionByStatus(pool);
        expect(open.length + archived.length).toBe(pool.length);
        const ids = new Set([...open, ...archived].map((session) => session.id));
        expect(ids.size).toBe(pool.length);
        expect(open.every((session) => !isArchived(session))).toBe(true);
        expect(archived.every((session) => isArchived(session))).toBe(true);
      }),
      RUNS,
    );
  });

  it("leaves the source Session untouched when archiving", () => {
    fc.assert(
      fc.property(sessionHistory, (fixture) => {
        const source: Session = { ...fixture.session, status: "idle" };
        const before = JSON.stringify(source);
        archiveSession(source, NOW);
        expect(JSON.stringify(source)).toBe(before);
      }),
      RUNS,
    );
  });
});
