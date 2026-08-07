/**
 * The approval dock's model — zoc-agent-chat-rebuild R11.7, R11.8, R11.9, R21.3, task 19.1.
 *
 * Feature: zoc-agent-chat-rebuild, task 19.1 (R11.7, R11.8, R11.9, R21.3).
 *
 * The arithmetic the dock is spacing around: which request is pending, how long it has, and what it is
 * called. Unit-tested here rather than through a rendered dock, because each of these is a decision with
 * an edge case rather than a layout — and the two properties beside this file assert the rendered
 * behaviour that depends on them.
 */

import { describe, expect, it } from "vitest";

import {
  APPROVAL_WINDOW_MS,
  DEFAULT_SCOPE,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  approvalAccessibleName,
  formatCountdown,
  hasExpired,
  isPending,
  offeredScopesOf,
  pendingRequestOf,
  permissionRequestsOf,
  remainingMs,
} from "@/features/chat/permission/permission-model";
import type { PermissionRequestPart } from "@zoc-studio/shared-types";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";

const NOW = Date.parse("2026-07-31T10:00:00.000Z");

function request(overrides: Partial<PermissionRequestPart> = {}): PermissionRequestPart {
  return {
    type: "permission-request",
    seq: 1,
    runId: "run_1",
    messageId: "m1",
    ts: "2026-07-31T10:00:00.000Z",
    agentName: null,
    requestId: "req_1",
    toolCallId: "call_1",
    toolName: "workspace_run_command",
    kind: "execute",
    prompt: "Allow workspace_run_command?",
    paths: [],
    reason: "mode-ask",
    offeredScopes: ["call", "run", "workspace"],
    expiresAt: new Date(NOW + APPROVAL_WINDOW_MS).toISOString(),
    decision: null,
    decidedScope: null,
    ...overrides,
  };
}

function messageWith(...requests: PermissionRequestPart[]): ZocUIMessage {
  return {
    id: "m1",
    role: "assistant",
    parts: requests.map((data) => ({ type: "data-zoc-permission" as const, data })),
  };
}

describe("the countdown (R11.9)", () => {
  it("formats minutes unpadded and seconds padded, like a clock", () => {
    expect(formatCountdown(APPROVAL_WINDOW_MS)).toBe("10:00 left");
    expect(formatCountdown(9 * 60_000 + 42_000)).toBe("9:42 left");
    expect(formatCountdown(62_000)).toBe("1:02 left");
    expect(formatCountdown(9_000)).toBe("0:09 left");
  });

  it("rounds up, so a live request never reads 0:00", () => {
    // The alternative is `0:00 left` beside two working buttons, which reads as a broken dock.
    expect(formatCountdown(900)).toBe("0:01 left");
    expect(formatCountdown(1)).toBe("0:01 left");
  });

  it("says expired at zero and below", () => {
    expect(formatCountdown(0)).toBe("expired");
    expect(formatCountdown(-5_000)).toBe("expired");
  });

  it("never reports a negative remainder", () => {
    expect(remainingMs(request({ expiresAt: new Date(NOW - 60_000).toISOString() }), NOW)).toBe(0);
    expect(hasExpired(request({ expiresAt: new Date(NOW - 1).toISOString() }), NOW)).toBe(true);
  });

  it("reads an unparseable deadline as the full window rather than as expired", () => {
    // The runtime owns the timeout. A surface that hid the controls over a malformed timestamp would
    // make an answerable question unanswerable, which is the worse failure of the two.
    expect(remainingMs(request({ expiresAt: "not a date" }), NOW)).toBe(APPROVAL_WINDOW_MS);
    expect(hasExpired(request({ expiresAt: "not a date" }), NOW)).toBe(false);
  });
});

describe("which request is pending", () => {
  it("treats an absent decision as pending and any decision as settled", () => {
    expect(isPending(request())).toBe(true);
    expect(isPending(request({ decision: null }))).toBe(true);
    for (const decision of ["approve", "reject", "timeout"] as const) {
      expect(isPending(request({ decision })), decision).toBe(false);
    }
  });

  it("returns the oldest pending request, so a queue drains in order", () => {
    const first = request({ requestId: "req_first", seq: 4 });
    const second = request({ requestId: "req_second", seq: 9 });
    // Deliberately out of order in the parts list: the model sorts by `seq` rather than trusting
    // arrival, because a restored transcript interleaves Runs.
    const pending = pendingRequestOf([messageWith(second, first)], NOW);
    expect(pending?.requestId).toBe("req_first");
  });

  it("skips a decided request and an expired one", () => {
    const decided = request({ requestId: "req_decided", seq: 1, decision: "approve" });
    const stale = request({
      requestId: "req_stale",
      seq: 2,
      expiresAt: new Date(NOW - 1_000).toISOString(),
    });
    const live = request({ requestId: "req_live", seq: 3 });

    expect(pendingRequestOf([messageWith(decided, stale, live)], NOW)?.requestId).toBe("req_live");
    expect(pendingRequestOf([messageWith(decided, stale)], NOW)).toBeNull();
  });

  it("finds requests across messages and reports none for a transcript with none", () => {
    expect(permissionRequestsOf([]).length).toBe(0);
    const messages: ZocUIMessage[] = [
      { id: "m0", role: "user", parts: [{ type: "text", text: "go" }] },
      messageWith(request({ requestId: "req_a", seq: 2 })),
      messageWith(request({ requestId: "req_b", seq: 5 })),
    ];
    expect(permissionRequestsOf(messages).map((entry) => entry.requestId)).toEqual([
      "req_a",
      "req_b",
    ]);
    expect(pendingRequestOf(messages, NOW)?.requestId).toBe("req_a");
  });
});

describe("the scopes (R11.7)", () => {
  it("orders them narrowest first, whatever order the runtime offered", () => {
    expect(offeredScopesOf(request({ offeredScopes: ["workspace", "call"] }))).toEqual([
      "call",
      "workspace",
    ]);
  });

  it("keeps only what was offered", () => {
    expect(offeredScopesOf(request({ offeredScopes: ["run"] }))).toEqual(["run"]);
  });

  it("offers the narrowest grant when the runtime offered none", () => {
    // Rendering no chips would read as "there is no way to say yes", and the gate always permits the
    // single-call grant.
    expect(offeredScopesOf(request({ offeredScopes: [] }))).toEqual([DEFAULT_SCOPE]);
  });

  it("labels each scope with what it grants, not just with its span", () => {
    for (const scope of ["call", "run", "workspace"] as const) {
      expect(SCOPE_LABELS[scope].length).toBeGreaterThan(0);
      // "This workspace" alone does not say that the grant outlives the Run.
      expect(SCOPE_DESCRIPTIONS[scope]).toMatch(/^Allow /);
    }
  });
});

describe("the accessible name (R21.3)", () => {
  it("names the tool, the reason, and every path", () => {
    const name = approvalAccessibleName(
      request({
        toolName: "workspace_apply_hunks",
        reason: "out-of-plan-path",
        paths: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"],
      }),
    );
    expect(name).toContain("workspace_apply_hunks");
    expect(name).toContain("Outside the plan's paths");
    for (const path of ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]) {
      // Every path, because the paths are what the user is being asked to approve — the visible row's
      // "+n more" collapse is for the eye and would be a hole in the ear.
      expect(name).toContain(path);
    }
  });

  it("reads as a question with no path list when a tool touches no path", () => {
    const name = approvalAccessibleName(request({ paths: [] }));
    expect(name).toBe("Approve workspace_run_command? Approval mode is on.");
  });

  it("uses the singular for one path", () => {
    expect(approvalAccessibleName(request({ paths: ["src/only.ts"] }))).toContain(
      "Affected path: src/only.ts",
    );
  });
});
