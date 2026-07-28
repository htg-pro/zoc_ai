// Feature: zoc-ai-agent-chat-overhaul, Property 31: Session state round-trips through selection, edit, and switching
//
// For any set of sessions with message histories: selecting a session loads
// exactly that session's history and makes it active; each listed session
// displays its title, last-activity timestamp, and workspace-root basename;
// renaming persists the new title and displays it; deletion occurs only after a
// confirming decision; and switching away from a session with an active run and
// back yields a tracked run record deeply equal to the one before the switch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import fc from "fast-check";

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(async () => undefined),
  trackEvent: vi.fn(async () => undefined),
  initTelemetry: vi.fn(async () => undefined),
}));

import type { Message, Session } from "@zoc-studio/shared-types";
import type { TrackedRun } from "../agent-runs";
import { useApp } from "@/lib/store";
import { rootBasename, sessionListItem } from "../session-origin";
import { SessionsPanel } from "@/features/sessions/SessionsPanel";

const initial = useApp.getState();

/** Reset to a clean, offline store and neutralise selectSession's side-loads. */
function resetStore(): void {
  useApp.setState({
    ...initial,
    liveMode: false,
    sessions: [],
    activeSessionId: "",
    chat: [],
    agentItems: [],
    trackedRuns: [],
    plan: null,
    // selectSession fires these off (unawaited) after loading history; stub
    // them so the property never reaches for a Gateway client.
    loadMemoryStats: async () => {},
    loadProjectRules: async () => {},
    loadCheckpoints: async () => {},
  });
  try {
    window.localStorage?.clear?.();
  } catch {
    /* the test environment's storage stub may not implement clear() */
  }
  // Switching to a session bound to a different workspace now requires
  // confirmation (R15.7); this property exercises pure round-trips, so accept.
  window.confirm = () => true;
}

function mkMessage(k: number, sid: string): Message {
  return {
    id: `${sid}-m${k}`,
    // Alternate roles so no two consecutive user messages exist — the store's
    // history fold only dedups consecutive identical user messages.
    role: k % 2 === 0 ? "user" : "assistant",
    content: `${sid} message ${k}`,
    created_at: new Date(1_700_000_000_000 + k * 3_600_000).toISOString(),
  };
}

function mkSession(i: number, msgCount: number, root: string, title: string): Session {
  const at = new Date(1_700_000_000_000 + i * 86_400_000).toISOString();
  return {
    id: `sess-${i}`,
    title,
    status: "active",
    workspace_root: root,
    provider: null,
    model: null,
    created_at: at,
    updated_at: at,
    messages: Array.from({ length: msgCount }, (_, k) => mkMessage(k, `sess-${i}`)),
    plan: null,
    tool_calls: [],
  };
}

const specsArb = fc.array(
  fc.record({
    msgCount: fc.integer({ min: 0, max: 3 }),
    root: fc.oneof(
      fc.constant("/home/user/project-alpha"),
      fc.constant("/home/user/project-beta"),
      fc.constant("/"),
      fc.string({ minLength: 1, maxLength: 8 }).map((s) => `/ws/${s.replace(/[/\\]/g, "_")}`),
    ),
    title: fc.string({ minLength: 1, maxLength: 20 }).map((s) => s.trim() || "untitled"),
  }),
  { minLength: 2, maxLength: 5 },
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Property 31 — session state round-trips", () => {
  it("selection loads history, rename persists, switching preserves the tracked run", async () => {
    await fc.assert(
      fc.asyncProperty(specsArb, async (specs) => {
        resetStore();
        const sessions = specs.map((s, i) => mkSession(i, s.msgCount, s.root, s.title));
        const keptRun: TrackedRun = {
          runId: "run-keep",
          mode: "agent",
          phase: "running",
          title: "keep me",
          startedAt: 1_000,
        };
        useApp.setState({
          sessions,
          activeSessionId: sessions[0].id,
          trackedRuns: [keptRun],
        });

        // Clause 2 — the display projection names title, last activity, and a
        // non-empty workspace-root basename.
        for (const s of sessions) {
          const item = sessionListItem(s);
          expect(item.title).toBe(s.title);
          expect(item.lastActivity).toBe(s.updated_at);
          expect(item.rootBasename).toBe(rootBasename(s.workspace_root));
          expect(item.rootBasename.length).toBeGreaterThan(0);
        }

        // Clause 1 — selecting loads exactly that session's history and activates it.
        const target = sessions[sessions.length - 1];
        await useApp.getState().selectSession(target.id);
        expect(useApp.getState().activeSessionId).toBe(target.id);
        const loadedIds = useApp
          .getState()
          .chat.filter((e) => e.kind === "message")
          .map((e) => e.message?.id);
        expect(loadedIds).toEqual(target.messages.map((m) => m.id));

        // Clause 5 — switch away and back; the tracked run record is unchanged.
        const before: TrackedRun[] = JSON.parse(JSON.stringify(useApp.getState().trackedRuns));
        await useApp.getState().selectSession(sessions[0].id);
        await useApp.getState().selectSession(target.id);
        expect(useApp.getState().trackedRuns).toEqual(before);

        // Clause 3 — rename persists and the projection reflects it.
        const newTitle = `renamed ${target.id}`;
        expect(await useApp.getState().renameSession(target.id, newTitle)).toBe(true);
        const renamed = useApp.getState().sessions.find((s) => s.id === target.id)!;
        expect(renamed.title).toBe(newTitle);
        expect(sessionListItem(renamed).title).toBe(newTitle);

        // Clause 4 (store safety) — deletion removes exactly the target.
        expect(await useApp.getState().deleteSession(target.id)).toBe(true);
        const remaining = useApp.getState().sessions.map((s) => s.id).sort();
        expect(remaining).not.toContain(target.id);
        expect(remaining).toEqual(
          sessions
            .filter((s) => s.id !== target.id)
            .map((s) => s.id)
            .sort(),
        );
      }),
      { numRuns: 120 },
    );
  });

  it("deletes a session only after a confirming decision (clause 4)", async () => {
    resetStore();
    const session = mkSession(0, 1, "/home/user/proj", "My Session");
    useApp.setState({ sessions: [session], activeSessionId: session.id });

    render(<SessionsPanel />);
    const del = screen.getByRole("button", { name: "Delete My Session" });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(del);
    await Promise.resolve();
    expect(useApp.getState().sessions.map((s) => s.id)).toContain(session.id);

    confirmSpy.mockReturnValue(true);
    fireEvent.click(del);
    await waitFor(() =>
      expect(useApp.getState().sessions.map((s) => s.id)).not.toContain(session.id),
    );
  });

  it("renders the workspace-root basename in the session list (R15.3)", () => {
    resetStore();
    const session = mkSession(0, 0, "/home/user/project-alpha", "Alpha");
    useApp.setState({ sessions: [session], activeSessionId: session.id });

    render(<SessionsPanel />);
    const root = screen.getByTestId("session-row-root");
    expect(root.textContent).toContain("project-alpha");
    expect(root).toHaveAttribute("title", "/home/user/project-alpha");
  });
});
