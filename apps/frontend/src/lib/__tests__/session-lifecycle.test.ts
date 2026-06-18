// Feature: chat-memory-session-system, Task 3.4
// Unit tests for `select` and `delete-active` fallbacks in resolveSessionIntent.
// Validates: Requirements 2.3, 2.4, 2.5
import { describe, expect, it } from "vitest";
import type { Session } from "@zoc-studio/shared-types";
import { resolveSessionIntent } from "../session-lifecycle";

/** Build a minimal, well-formed Session with the given id. */
function makeSession(id: string): Session {
  return {
    id,
    title: `session ${id}`,
    status: "active",
    workspace_root: "/tmp",
    provider: null,
    model: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    messages: [],
    plan: null,
    tool_calls: [],
  };
}

describe("resolveSessionIntent: select fallbacks (R2.3, R2.4)", () => {
  it("select with a present id resolves to select with that id", () => {
    const sessions = [makeSession("a"), makeSession("b"), makeSession("c")];

    const intent = resolveSessionIntent({
      trigger: "select",
      sessions,
      lastActiveId: null,
      selectedId: "b",
    });

    expect(intent).toEqual({ kind: "select", sessionId: "b" });
  });

  it("select with an absent id resolves to fresh", () => {
    const sessions = [makeSession("a"), makeSession("b")];

    const intent = resolveSessionIntent({
      trigger: "select",
      sessions,
      lastActiveId: null,
      selectedId: "missing",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("select with an empty-string id resolves to fresh", () => {
    const sessions = [makeSession("a")];

    const intent = resolveSessionIntent({
      trigger: "select",
      sessions,
      lastActiveId: null,
      selectedId: "",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("select with a null id resolves to fresh", () => {
    const sessions = [makeSession("a")];

    const intent = resolveSessionIntent({
      trigger: "select",
      sessions,
      lastActiveId: null,
      selectedId: null,
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("select with an undefined id resolves to fresh", () => {
    const sessions = [makeSession("a")];

    const intent = resolveSessionIntent({
      trigger: "select",
      sessions,
      lastActiveId: null,
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("select against an empty session list resolves to fresh", () => {
    const intent = resolveSessionIntent({
      trigger: "select",
      sessions: [],
      lastActiveId: null,
      selectedId: "a",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });
});

describe("resolveSessionIntent: delete-active fallback (R2.5)", () => {
  it("delete-active resolves to fresh when other sessions remain", () => {
    const sessions = [makeSession("a"), makeSession("b"), makeSession("c")];

    const intent = resolveSessionIntent({
      trigger: "delete-active",
      sessions,
      lastActiveId: "a",
      selectedId: "a",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("delete-active resolves to fresh regardless of lastActiveId naming a session", () => {
    const sessions = [makeSession("a"), makeSession("b")];

    const intent = resolveSessionIntent({
      trigger: "delete-active",
      sessions,
      lastActiveId: "b",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("delete-active resolves to fresh when no sessions remain", () => {
    const intent = resolveSessionIntent({
      trigger: "delete-active",
      sessions: [],
      lastActiveId: "gone",
      selectedId: "gone",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });

  it("delete-active resolves to fresh even when selectedId still names a session", () => {
    const sessions = [makeSession("a")];

    const intent = resolveSessionIntent({
      trigger: "delete-active",
      sessions,
      lastActiveId: null,
      selectedId: "a",
    });

    expect(intent).toEqual({ kind: "fresh" });
  });
});
