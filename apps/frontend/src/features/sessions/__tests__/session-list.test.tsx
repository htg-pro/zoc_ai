/**
 * The Session list and its three guards — zoc-agent-chat-rebuild R15.3, R15.4, R15.5, R15.10, R15.11,
 * R35.2, R35.5, task 22.5.
 *
 * The properties beside this file assert the model. What is asserted here is the rendered list: the three
 * facts on a row, the search measurement over a realistic fixture, the archive partition as a user sees it,
 * and the delete confirmation that replaced two `window.confirm` calls.
 *
 * ## Why the search guard measures the model rather than the rendered list
 *
 * R15.5's 300 ms is about answering "which Sessions mention this", and the answer is `searchSessions` over
 * 500 Sessions at roughly 40 messages each — 20,000 messages, which is the fixture the task names. Rendering
 * the result is bounded by the *rows*, not by the corpus, and jsdom's DOM is not a fair proxy for that half
 * (the same reason 20.2's guard split). So the corpus cost is measured here and the row cost is a fact about
 * a list of at most a few hundred rows.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SessionList } from "@/features/sessions/SessionList";
import { archiveSession, searchSessions } from "@/features/sessions/session-list-model";
import type { Message, Session } from "@zoc-studio/shared-types";

afterEach(cleanup);

const ROOT = "/work/proj";
const NOW = Date.parse("2026-07-31T10:00:00.000Z");

function messagesOf(count: number, seed: number): Message[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `m_${String(seed)}_${String(index)}`,
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    // One in every corpus mentions the needle, so the search has something to find and something to skip.
    content:
      index === 3 && seed % 7 === 0
        ? "the token helper needs replacing"
        : `turn ${String(index)} of session ${String(seed)}`,
    name: null,
    tool_call_id: null,
    created_at: new Date(NOW - index * 1_000).toISOString(),
  }));
}

function sessionOf(overrides: Partial<Session> & { id: string }): Session {
  return {
    title: `Session ${overrides.id}`,
    status: "idle",
    workspace_root: ROOT,
    provider: null,
    model: null,
    created_at: new Date(NOW - 60_000).toISOString(),
    updated_at: new Date(NOW - 60_000).toISOString(),
    messages: [],
    plan: null,
    tool_calls: [],
    ...overrides,
  };
}

function corpus(sessionCount: number, messagesEach: number): Session[] {
  return Array.from({ length: sessionCount }, (_, index) =>
    sessionOf({
      id: `s_${String(index)}`,
      title: `Session ${String(index)}`,
      messages: messagesOf(messagesEach, index),
      updated_at: new Date(NOW - index * 60_000).toISOString(),
    }),
  );
}

/**
 * Open a row's action menu with the keyboard.
 *
 * Radix opens a `DropdownMenu` on `pointerdown`, which jsdom does not synthesise from `fireEvent.click` —
 * and pressing Enter on the focused trigger is both what works here and what a keyboard user does, so the
 * indirection buys an accessibility assertion rather than only a workaround.
 */
function openMenu(container: HTMLElement, sessionId: string): void {
  const trigger = container.querySelector(`[data-zoc-session-menu='${sessionId}']`);
  if (!(trigger instanceof HTMLElement)) throw new Error(`no menu for ${sessionId}`);
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

function renderList(
  sessions: readonly Session[],
  overrides: Partial<Parameters<typeof SessionList>[0]> = {},
) {
  return render(
    <SessionList
      sessions={sessions}
      activeSessionId={overrides.activeSessionId ?? null}
      workspaceRoot={overrides.workspaceRoot ?? ROOT}
      now={NOW}
      onSelect={overrides.onSelect ?? (() => undefined)}
      {...overrides}
    />,
  );
}

describe("Feature: zoc-agent-chat-rebuild, task 22.5: the Session list", () => {
  it("shows the three facts R15.3 names, and puts all of them in the accessible name", () => {
    const view = renderList([
      sessionOf({ id: "s_1", title: "Refactor auth", messages: messagesOf(6, 0) }),
    ]);

    const row = view.container.querySelector("[data-zoc-session-row='s_1']");
    expect(row).not.toBeNull();
    expect(screen.getByText("Refactor auth")).toBeInTheDocument();
    // Count and last activity, visible.
    expect(view.container.querySelector("[data-zoc-session-count='6']")).not.toBeNull();
    expect(screen.getByText("1m ago")).toBeInTheDocument();
    // And spoken as one sentence, because a screen-reader user choosing between Sessions needs all three
    // rather than the title alone.
    const name = view.container
      .querySelector("[data-zoc-session-select='s_1']")
      ?.getAttribute("aria-label");
    expect(name).toContain("Refactor auth");
    expect(name).toContain("6 messages");
    expect(name).toContain("1m ago");
  });

  it("lists only the active workspace's Sessions (R15.10)", () => {
    const view = renderList([
      sessionOf({ id: "here", workspace_root: "/work/proj/" }),
      sessionOf({ id: "also-here", workspace_root: "/Work/Proj" }),
      sessionOf({ id: "elsewhere", workspace_root: "/work/other" }),
    ]);

    // Two spellings of one folder are one folder; a different folder is absent.
    expect(view.container.querySelector("[data-zoc-session-row='here']")).not.toBeNull();
    expect(view.container.querySelector("[data-zoc-session-row='also-here']")).not.toBeNull();
    expect(view.container.querySelector("[data-zoc-session-row='elsewhere']")).toBeNull();
  });

  it("keeps an archived Session out of the default list and shows it under the filter (R15.11)", () => {
    const open = sessionOf({ id: "open-one", messages: messagesOf(4, 1) });
    const archived = archiveSession(
      sessionOf({ id: "archived-one", messages: messagesOf(4, 2) }),
      new Date(NOW).toISOString(),
    );
    const view = renderList([open, archived]);

    expect(view.container.querySelector("[data-zoc-session-row='open-one']")).not.toBeNull();
    expect(view.container.querySelector("[data-zoc-session-row='archived-one']")).toBeNull();

    fireEvent.click(view.container.querySelector("[data-zoc-session-filter-tab='archived']") as HTMLElement);

    expect(view.container.querySelector("[data-zoc-session-row='archived-one']")).not.toBeNull();
    expect(view.container.querySelector("[data-zoc-session-row='open-one']")).toBeNull();
    // The archived Session still has its transcript: archiving is a status change, and the row's own count
    // is the visible proof.
    expect(view.container.querySelector("[data-zoc-session-count='4']")).not.toBeNull();
  });

  it("searches message text, not just titles (R15.5)", () => {
    const view = renderList([
      sessionOf({ id: "mentions", title: "Untitled", messages: messagesOf(6, 0) }),
      sessionOf({ id: "silent", title: "Untitled too", messages: messagesOf(6, 1) }),
    ]);

    fireEvent.change(view.container.querySelector("[data-zoc-session-search]") as HTMLElement, {
      target: { value: "token helper" },
    });

    expect(view.container.querySelector("[data-zoc-session-row='mentions']")).not.toBeNull();
    expect(view.container.querySelector("[data-zoc-session-row='silent']")).toBeNull();

    // Clearing restores the list rather than emptying it.
    fireEvent.change(view.container.querySelector("[data-zoc-session-search]") as HTMLElement, {
      target: { value: "" },
    });
    expect(view.container.querySelector("[data-zoc-session-row='silent']")).not.toBeNull();
  });

  it("says so when nothing matches, rather than showing an empty list", () => {
    const view = renderList([sessionOf({ id: "s_1", messages: messagesOf(2, 1) })]);
    fireEvent.change(view.container.querySelector("[data-zoc-session-search]") as HTMLElement, {
      target: { value: "nothing like this" },
    });
    expect(screen.getByText("No session matches that.")).toBeInTheDocument();
  });

  it("confirms a delete through a dialog and reports only on confirmation (R15.4)", () => {
    const onDelete = vi.fn();
    const view = renderList([sessionOf({ id: "doomed", title: "Old work", messages: messagesOf(3, 1) })], {
      onDelete,
    });

    openMenu(view.container, "doomed");
    fireEvent.click(document.querySelector('[data-zoc-session-action="delete"]') as HTMLElement);

    // A Radix dialog rather than `window.confirm`, which is untrappable, unstylable, and invisible to the
    // accessibility tree.
    expect(screen.getByText("Delete this session?")).toBeInTheDocument();
    // The copy names what is lost and offers the reversible alternative.
    expect(screen.getByText(/3 messages are removed/)).toBeInTheDocument();
    expect(screen.getByText(/archive it instead/)).toBeInTheDocument();

    fireEvent.click(document.querySelector("[data-zoc-session-delete-cancel]") as HTMLElement);
    expect(onDelete).not.toHaveBeenCalled();

    openMenu(view.container, "doomed");
    fireEvent.click(document.querySelector('[data-zoc-session-action="delete"]') as HTMLElement);
    fireEvent.click(document.querySelector("[data-zoc-session-delete-confirm]") as HTMLElement);
    expect(onDelete).toHaveBeenCalledWith("doomed");
  });

  it("renames inline, commits on Enter, and reverts on Escape", () => {
    const onRename = vi.fn();
    const view = renderList([sessionOf({ id: "s_1", title: "Before" })], { onRename });

    const startEditing = () => {
      openMenu(view.container, "s_1");
      fireEvent.click(document.querySelector('[data-zoc-session-action="rename"]') as HTMLElement);
      return view.container.querySelector("[data-zoc-session-rename-input='s_1']") as HTMLInputElement;
    };

    const input = startEditing();
    fireEvent.change(input, { target: { value: "After" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("s_1", "After");

    const second = startEditing();
    fireEvent.change(second, { target: { value: "Abandoned" } });
    fireEvent.keyDown(second, { key: "Escape" });
    // Escape reverts, so an accidental rename costs one key rather than a second rename.
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("offers fork, duplicate, and archive, and omits what the surface did not supply", () => {
    const onFork = vi.fn();
    const view = renderList([sessionOf({ id: "s_1" })], { onFork });

    openMenu(view.container, "s_1");
    fireEvent.click(document.querySelector('[data-zoc-session-action="fork"]') as HTMLElement);
    expect(onFork).toHaveBeenCalledWith("s_1");

    // Absent rather than disabled: a surface that cannot duplicate offers no duplicate item.
    expect(document.querySelector('[data-zoc-session-action="duplicate"]')).toBeNull();
    expect(document.querySelector('[data-zoc-session-action="archive"]')).toBeNull();
  });

  it("says session, never thread (R35.5)", () => {
    const view = renderList([sessionOf({ id: "s_1" })], { onDelete: () => undefined });
    openMenu(view.container, "s_1");
    fireEvent.click(document.querySelector('[data-zoc-session-action="delete"]') as HTMLElement);

    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).not.toContain("thread");
    expect(text.toLowerCase()).toContain("session");
  });

  it("answers a search over 500 sessions of 40 messages within 300 ms (R15.5)", () => {
    // The fixture the task names: 500 × 40 is 20,000 messages, which is the corpus a real user accumulates
    // over months and the size at which a naive per-keystroke search stops being usable.
    const pool = corpus(500, 40);
    const total = pool.reduce((count, session) => count + session.messages.length, 0);
    expect(total).toBe(20_000);

    let worst = 0;
    // Several queries, including one that matches almost nothing and one that matches many: the cost of a
    // search that finds nothing is not the cost of one that finds five hundred.
    for (const query of ["token helper", "turn 3", "session 4", "nothing at all", "t"]) {
      const started = performance.now();
      const hits = searchSessions(pool, query);
      worst = Math.max(worst, performance.now() - started);
      expect(hits.length).toBeGreaterThanOrEqual(0);
    }

    expect(worst).toBeLessThan(300);
  });
});
