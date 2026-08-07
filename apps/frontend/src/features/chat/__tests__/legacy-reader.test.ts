/**
 * The legacy reader — zoc-agent-chat-rebuild R23.1, R23.2, R23.4, R23.5, task 24.6.
 *
 * Every arm of `mapLegacyEvent`, each of the four unreadable-conversation failure modes, the partial
 * case, and the assertion that the reader opens the legacy store read-only.
 *
 * ## Why the read-only assertion is a test and not a comment
 *
 * `LegacyStore` has no write method, so "the reader cannot write" is true by construction — but only
 * as long as the reader depends on that port and nothing else. The test passes a store carrying
 * *extra* write methods and asserts none is called, which is what catches the change that reaches
 * past the interface. R23.5's failure is silent and permanent: a migration that mutates the
 * pre-upgrade record leaves nothing to compare against afterwards.
 */

import { describe, expect, it, vi } from "vitest";

import {
  FAILURE_MESSAGE,
  isUnreadable,
  mapLegacyEvent,
  orderAndRenumber,
  readLegacyConversation,
  readLegacyConversations,
  type LegacyConversationRef,
  type LegacyStore,
  type MigratedSession,
} from "@/features/chat/migration/legacy-reader";

const CONTEXT = { messageId: "m1", seq: 7 } as const;

/** `BaseEvent`'s three fields, which every legacy record carries. */
const BASE = { seq: 3, runId: "run_1", ts: "2026-07-01T10:00:00.000Z" } as const;

const REF: LegacyConversationRef = {
  id: "c1",
  title: "Old conversation",
  updatedAt: "2026-07-01T10:00:00.000Z",
};

function storeOf(events: readonly unknown[] | (() => never)): LegacyStore {
  return {
    listConversations: () => Promise.resolve([REF]),
    readEvents: () =>
      typeof events === "function" ? Promise.reject(events()) : Promise.resolve(events),
  };
}

describe("Feature: zoc-agent-chat-rebuild, task 24.1: mapLegacyEvent covers every declared kind (R23.2)", () => {
  it("maps prose events to a text part", () => {
    for (const type of ["intent", "summary"]) {
      const result = mapLegacyEvent({ ...BASE, type, text: "hello" }, CONTEXT);
      expect(result.outcome, type).toBe("mapped");
      if (result.outcome !== "mapped") return;
      expect(result.parts[0]).toMatchObject({ type: "text", delta: "hello", done: true, seq: 7 });
    }
  });

  it("maps thinking to a reasoning part, carrying truncation as redaction", () => {
    const result = mapLegacyEvent(
      { ...BASE, type: "thinking", text: "considering", elapsedMs: 900, truncated: true },
      CONTEXT,
    );
    expect(result.outcome).toBe("mapped");
    if (result.outcome !== "mapped") return;
    expect(result.parts[0]).toMatchObject({
      type: "reasoning",
      delta: "considering",
      elapsedMs: 900,
      done: true,
      redacted: true,
    });
  });

  it("maps plan-ready to a plan part, one file per step", () => {
    const result = mapLegacyEvent(
      {
        ...BASE,
        type: "plan-ready",
        steps: [
          { file: "src/a.ts", action: "create", rationale: "new", diff: "@@" },
          { file: "src/b.ts", action: "nonsense", rationale: "why" },
        ],
        verificationCommand: "pnpm test",
      },
      CONTEXT,
    );
    expect(result.outcome).toBe("mapped");
    if (result.outcome !== "mapped") return;
    const part = result.parts[0] as {
      files: { path: string; action: string; hunkCount: number }[];
    };
    expect(part.files).toHaveLength(2);
    expect(part.files[0]).toMatchObject({ path: "src/a.ts", action: "create", hunkCount: 1 });
    // An action outside the four falls back rather than propagating a value the renderer cannot draw.
    expect(part.files[1]).toMatchObject({ path: "src/b.ts", action: "modify", hunkCount: 0 });
  });

  it("maps context-compressed to a compaction part with the two token figures", () => {
    const result = mapLegacyEvent(
      {
        ...BASE,
        type: "context-compressed",
        originalTokens: 8000,
        compressedTokens: 2000,
        compressionRatio: 0.25,
      },
      CONTEXT,
    );
    expect(result.outcome).toBe("mapped");
    if (result.outcome !== "mapped") return;
    expect(result.parts[0]).toMatchObject({
      type: "compaction",
      contextTokensBefore: 8000,
      contextTokensAfter: 2000,
      foldedMessageIds: [],
    });
  });

  it("maps edit-file to a diff part that is always stale (R23.5)", () => {
    const result = mapLegacyEvent(
      {
        ...BASE,
        type: "edit-file",
        path: "src/a.ts",
        diff: "@@ -1 +1 @@",
        adds: 4,
        dels: 2,
        status: "done",
      },
      CONTEXT,
    );
    expect(result.outcome).toBe("mapped");
    if (result.outcome !== "mapped") return;
    const part = result.parts[0] as { stale: boolean; hunks: { patch: string }[]; path: string };
    // Staleness is the guard that stops a pre-upgrade diff being applied to today's workspace.
    expect(part.stale).toBe(true);
    expect(part.path).toBe("src/a.ts");
    expect(part.hunks[0]?.patch).toBe("@@ -1 +1 @@");
  });

  it("maps read-files to a tool output carrying the paths", () => {
    const result = mapLegacyEvent(
      { ...BASE, type: "read-files", files: [{ path: "a.ts" }, { path: "b.ts" }] },
      CONTEXT,
    );
    expect(result.outcome).toBe("mapped");
    if (result.outcome !== "mapped") return;
    expect(result.parts[0]).toMatchObject({
      type: "tool-output",
      readPaths: ["a.ts", "b.ts"],
      summary: "Read 2 files",
    });
  });

  it("splits command on its status: output when it passed, tool-error when it failed", () => {
    const passed = mapLegacyEvent(
      { ...BASE, type: "command", command: "ls", status: "pass" },
      CONTEXT,
    );
    expect(passed.outcome).toBe("mapped");
    if (passed.outcome === "mapped") expect(passed.parts[0]?.type).toBe("tool-output");

    const failed = mapLegacyEvent(
      { ...BASE, type: "command", command: "ls", status: "fail", exitCode: 2, errorTag: "enoent" },
      CONTEXT,
    );
    expect(failed.outcome).toBe("mapped");
    if (failed.outcome !== "mapped") return;
    expect(failed.parts[0]).toMatchObject({
      type: "tool-error",
      code: "enoent",
      message: "ls exited 2",
      // A pre-upgrade command has no workspace to retry into.
      retryable: false,
    });
  });

  it("splits test-results the same way, and names a timeout distinctly", () => {
    const passed = mapLegacyEvent(
      {
        ...BASE,
        type: "test-results",
        status: "pass",
        command: "pnpm test",
        passed: 12,
        failed: 0,
      },
      CONTEXT,
    );
    expect(passed.outcome).toBe("mapped");
    if (passed.outcome === "mapped") {
      expect(passed.parts[0]).toMatchObject({
        type: "tool-output",
        summary: "12 passed — pnpm test",
      });
    }

    const timedOut = mapLegacyEvent(
      { ...BASE, type: "test-results", status: "fail", passed: 1, failed: 3, timedOut: true },
      CONTEXT,
    );
    expect(timedOut.outcome).toBe("mapped");
    if (timedOut.outcome !== "mapped") return;
    expect(timedOut.parts[0]).toMatchObject({ type: "tool-error", code: "tests_timed_out" });
  });

  it("maps both permission shapes to an already-decided request", () => {
    const approval = mapLegacyEvent(
      { ...BASE, type: "approval", prompt: "Run it?", operation: "shell", decision: "approve" },
      CONTEXT,
    );
    expect(approval.outcome).toBe("mapped");
    if (approval.outcome === "mapped") {
      expect(approval.parts[0]).toMatchObject({
        type: "permission-request",
        toolName: "shell",
        decision: "approve",
      });
    }

    const denied = mapLegacyEvent(
      {
        ...BASE,
        type: "permission",
        kind: "fs",
        name: "write",
        target: "/etc",
        effect: "deny",
        reason: "outside root",
      },
      CONTEXT,
    );
    expect(denied.outcome).toBe("mapped");
    if (denied.outcome !== "mapped") return;
    expect(denied.parts[0]).toMatchObject({
      type: "permission-request",
      toolName: "write",
      paths: ["/etc"],
      decision: "reject",
    });
  });

  it("maps budget to a usage part and done to a run-lifecycle part", () => {
    const budget = mapLegacyEvent(
      { ...BASE, type: "budget", tokensUsed: 500, tokenLimit: 8000, iterations: 3, recoveries: 0 },
      CONTEXT,
    );
    expect(budget.outcome).toBe("mapped");
    if (budget.outcome === "mapped") {
      expect(budget.parts[0]).toMatchObject({
        type: "usage",
        inputTokens: 500,
        contextLimit: 8000,
      });
    }

    const failed = mapLegacyEvent(
      { ...BASE, type: "done", ok: false, reason: "cancelled by user", filesChanged: 0 },
      CONTEXT,
    );
    expect(failed.outcome).toBe("mapped");
    if (failed.outcome !== "mapped") return;
    expect(failed.parts[0]).toMatchObject({
      type: "run-lifecycle",
      state: "failed",
      message: "cancelled by user",
    });
  });

  it("skips telemetry-only events without producing a row", () => {
    for (const type of ["plan-update", "map-files"]) {
      const result = mapLegacyEvent({ ...BASE, type }, CONTEXT);
      expect(result.outcome, type).toBe("skipped");
    }
  });

  it("turns user-facing events with no counterpart into a historical row (R23.2)", () => {
    const stage = mapLegacyEvent(
      { ...BASE, type: "stage", stage: "analyze", state: "active" },
      CONTEXT,
    );
    expect(stage.outcome).toBe("historical");
    if (stage.outcome === "historical") {
      // The stage name is the whole content of the row, because the collapsing rule shows only the
      // latest of a consecutive run.
      expect(stage.label).toBe("Stage: analyze (active)");
    }

    for (const type of ["plan", "review", "recovery-attempt"]) {
      expect(mapLegacyEvent({ ...BASE, type }, CONTEXT).outcome, type).toBe("historical");
    }
  });

  it("degrades an unrecognised kind and a non-object record rather than throwing (R23.2)", () => {
    // The safe direction: a kind this reader was never taught is history, not a dropped turn.
    expect(mapLegacyEvent({ ...BASE, type: "invented-in-2027" }, CONTEXT).outcome).toBe(
      "historical",
    );
    for (const junk of [null, 42, "a string", undefined]) {
      const result = mapLegacyEvent(junk, CONTEXT);
      expect(result.outcome, String(junk)).toBe("historical");
    }
  });

  it("falls back to history when a mapped kind carries an unusable payload", () => {
    // `intent` is in the mapped set, but an empty `text` builds no part — and vanishing would be
    // worse than a neutral row, because the event was user-facing.
    expect(mapLegacyEvent({ ...BASE, type: "intent", text: "" }, CONTEXT).outcome).toBe(
      "historical",
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 24.1: sequence re-numbering (R23.2)", () => {
  it("renumbers from 1 in timestamp order, breaking ties on the original sequence", () => {
    const ordered = orderAndRenumber([
      { type: "a", ts: "2026-07-01T10:00:02.000Z", seq: 1 },
      { type: "b", ts: "2026-07-01T10:00:01.000Z", seq: 2 },
      // Same millisecond as the one above: the original sequence is what separates them.
      { type: "c", ts: "2026-07-01T10:00:01.000Z", seq: 1 },
    ]);

    expect(ordered.map((entry) => (entry.record as { type: string }).type)).toEqual([
      "c",
      "b",
      "a",
    ]);
    expect(ordered.map((entry) => entry.seq)).toEqual([1, 2, 3]);
    // The pre-migration number is retained for forensics rather than overwritten.
    expect(ordered.map((entry) => entry.originalSeq)).toEqual([1, 2, 1]);
  });

  it("keeps a record with an unparseable timestamp instead of discarding it", () => {
    const ordered = orderAndRenumber([
      { type: "good", ts: "2026-07-01T10:00:00.000Z", seq: 2 },
      { type: "broken", ts: "not a date", seq: 1 },
    ]);
    expect(ordered).toHaveLength(2);
    expect(ordered.map((entry) => entry.seq)).toEqual([1, 2]);
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 24.1: conversation-level failure isolation (R23.4)", () => {
  it("reports a transport failure as fetch-failed", async () => {
    const result = await readLegacyConversation(
      storeOf(() => {
        throw new TypeError("network down");
      }),
      REF,
    );
    expect(isUnreadable(result)).toBe(true);
    if (!isUnreadable(result)) return;
    expect(result.reason).toBe("fetch-failed");
    expect(result.message).toBe(FAILURE_MESSAGE["fetch-failed"]);
  });

  it("reports a corrupt record as malformed-json, distinctly from a transport failure", async () => {
    const result = await readLegacyConversation(
      storeOf(() => {
        throw new SyntaxError("Unexpected end of JSON input");
      }),
      REF,
    );
    expect(isUnreadable(result)).toBe(true);
    if (!isUnreadable(result)) return;
    // The two are not collapsed: one says the store is silent, the other says the record is corrupt.
    expect(result.reason).toBe("malformed-json");
  });

  it("reports a non-array payload as schema-rejected", async () => {
    const store: LegacyStore = {
      listConversations: () => Promise.resolve([REF]),
      readEvents: () => Promise.resolve({ not: "an array" } as unknown as readonly unknown[]),
    };
    const result = await readLegacyConversation(store, REF);
    expect(isUnreadable(result)).toBe(true);
    if (isUnreadable(result)) expect(result.reason).toBe("schema-rejected");
  });

  it("reports a file of unidentifiable records as schema-rejected, not as a wall of history", async () => {
    const result = await readLegacyConversation(storeOf([{ nope: 1 }, { nope: 2 }]), REF);
    expect(isUnreadable(result)).toBe(true);
    if (isUnreadable(result)) expect(result.reason).toBe("schema-rejected");
  });

  it("renders the mappable turns and names the skipped count when only some fail (R23.4)", async () => {
    const result = await readLegacyConversation(
      storeOf([
        { ...BASE, type: "summary", text: "done", ts: "2026-07-01T10:00:01.000Z" },
        { garbage: true, ts: "2026-07-01T10:00:02.000Z" },
        { ...BASE, type: "stage", stage: "edit", state: "active", ts: "2026-07-01T10:00:03.000Z" },
      ]),
      REF,
    );

    expect(isUnreadable(result)).toBe(false);
    const session = result as MigratedSession;
    expect(session.parts).toHaveLength(1);
    expect(session.parts[0]?.type).toBe("text");
    // The unidentifiable record and the stage event both become rows; only the first is *skipped*.
    expect(session.historical).toHaveLength(2);
    expect(session.skipped).toEqual({ reason: "partial", count: 1 });
  });

  it("keeps the remaining conversations available when one is unreadable (R23.4)", async () => {
    const good: LegacyConversationRef = { id: "ok", title: "Fine", updatedAt: REF.updatedAt };
    const bad: LegacyConversationRef = { id: "bad", title: "Broken", updatedAt: REF.updatedAt };
    const store: LegacyStore = {
      listConversations: () => Promise.resolve([good, bad]),
      readEvents: (id) =>
        id === "bad"
          ? Promise.reject(new TypeError("gone"))
          : Promise.resolve([{ ...BASE, type: "summary", text: "hi" }]),
    };

    const { sessions, unreadable } = await readLegacyConversations(store);
    expect(sessions.map((session) => session.id)).toEqual(["ok"]);
    expect(unreadable.map((entry) => entry.id)).toEqual(["bad"]);
  });

  it("presents every migrated conversation as a Session (R23.6)", async () => {
    const { sessions } = await readLegacyConversations(
      storeOf([{ ...BASE, type: "summary", text: "hi" }]),
    );
    expect(sessions).toHaveLength(1);
    // Same vocabulary as a new Session: an id, a title, and a timestamp that orders one list.
    expect(sessions[0]).toMatchObject({
      id: "c1",
      title: "Old conversation",
      updatedAt: REF.updatedAt,
    });
  });
});

describe("Feature: zoc-agent-chat-rebuild, task 24.1: the store is opened read-only (R23.5)", () => {
  it("calls no write method, even when one is available on the object it was handed", async () => {
    // The port cannot express a write, so this passes a store that *can* and asserts the reader does
    // not reach past its interface. That is the change this test exists to catch.
    const forbidden = {
      writeEvents: vi.fn(),
      deleteConversation: vi.fn(),
      updateConversation: vi.fn(),
    };
    const store = {
      listConversations: vi.fn(() => Promise.resolve([REF])),
      readEvents: vi.fn(() => Promise.resolve([{ ...BASE, type: "summary", text: "hi" }])),
      ...forbidden,
    };

    await readLegacyConversations(store as unknown as LegacyStore);

    expect(store.listConversations).toHaveBeenCalledTimes(1);
    expect(store.readEvents).toHaveBeenCalledTimes(1);
    for (const [name, spy] of Object.entries(forbidden)) {
      expect(
        spy,
        `${name} was called — the reader must never write to the legacy store`,
      ).not.toHaveBeenCalled();
    }
  });

  it("returns empty lists rather than inventing an entry when listing itself fails", async () => {
    const store: LegacyStore = {
      listConversations: () => Promise.reject(new TypeError("offline")),
      readEvents: () => Promise.resolve([]),
    };
    // Nothing to isolate: no conversation was named, so there is no id to report as unreadable.
    await expect(readLegacyConversations(store)).resolves.toEqual({ sessions: [], unreadable: [] });
  });
});
