/**
 * Property 86 — one Session_Store means every rendered Session_List agrees — zoc-agent-chat-rebuild
 * R35.1, R35.2, R35.3, R35.4, task 25.7.
 *
 * Three surfaces render Sessions: the header's {@link SessionSwitcher} (which renders the 22.5
 * {@link SessionList}), the workspace {@link SessionsPanel}, and the workspace {@link SessionsView}. All
 * three are mounted here against the one `useApp` store, a generated sequence of lifecycle actions is
 * applied to that store, and after **every** action each surface's rendered Session set is compared with an
 * expectation written here rather than derived from `session-list-model`.
 *
 * ## Why the expectation is restated instead of imported
 *
 * `sessionRows` is what the list renders through, so an oracle built from it would move with it and a
 * scoping regression would satisfy both sides. The expectation below is three literal filters over
 * `useApp.getState().sessions`:
 *
 * | surface | declared filter |
 * | --- | --- |
 * | the switcher's list | this workspace's root, and not archived (R15.10, R15.11) |
 * | the sessions panel | every Session in the store — `groupSessions` is a total partition |
 * | the sessions view, tab `all` | every Session in the store — `matchesFilter(s, "all")` is `true` |
 *
 * `lifecycleActions` puts every generated Session under one shared root, so the list's root filter admits
 * all of them and its declared filter reduces to "not archived". That is deliberate: a per-workspace filter
 * that made every surface trivially empty would let all three agree vacuously.
 *
 * ## Why the harness applies the pure copy functions rather than store actions
 *
 * Rename and delete run through the store, because those actions exist there. Fork, duplicate, and archive
 * do not — they live as pure functions in `session-list-model.ts` — so the harness applies them and writes
 * the result back through `setState`, which is the same single store the three surfaces read. `create` is
 * the deliberate exception: `createSession` reaches for a Gateway client before falling back to a local
 * Session, so the insert is done here from the intent {@link resolveSessionIntent} returned, which is the
 * half of R35.4 an agreement check alone would miss.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import fc from "fast-check";

vi.mock("@/lib/telemetry", () => ({
  track: vi.fn(async () => undefined),
  trackEvent: vi.fn(async () => undefined),
  initTelemetry: vi.fn(async () => undefined),
}));

import type { Session } from "@zoc-studio/shared-types";
import { useApp } from "@/lib/store";
import { resolveSessionIntent } from "@/lib/session-lifecycle";
import { archiveSession, duplicateSession, forkSession } from "../session-list-model";
import { SessionsPanel } from "../SessionsPanel";
import { SessionsView } from "../SessionsView";
import { SessionSwitcher } from "@/features/chat/header/SessionSwitcher";
import { lifecycleActions } from "@/features/chat/__tests__/arbitraries";

const initial = useApp.getState();
const BASE_MS = Date.parse("2026-08-01T12:00:00.000Z");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** All three surfaces, over the one store. */
function Surfaces({ onSelect }: { onSelect: (id: string) => void }) {
  const sessions = useApp((s) => s.sessions);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const workspaceRoot = useApp((s) => s.workspaceRoot);
  const pinned = useApp((s) => s.pinnedSessions);

  return (
    <>
      <SessionSwitcher
        title="Active session"
        sessions={sessions}
        activeSessionId={activeSessionId === "" ? null : activeSessionId}
        workspaceRoot={workspaceRoot}
        pinned={pinned}
        onSelect={onSelect}
      />
      <div data-surface="panel">
        <SessionsPanel />
      </div>
      <div data-surface="view">
        <SessionsView />
      </div>
    </>
  );
}

/** Reset to a clean, offline store. `liveMode: false` keeps rename and delete off the Gateway. */
function resetStore(root: string): void {
  useApp.setState({
    ...initial,
    liveMode: false,
    sessions: [],
    activeSessionId: "",
    agentItems: [],
    trackedRuns: [],
    plan: null,
    pinnedSessions: {},
    workspaceRoot: root,
  });
  try {
    window.localStorage?.clear?.();
  } catch {
    /* the test environment's storage stub may not implement clear() */
  }
}

/** The Session ids a surface has rendered, as a set: each surface sorts differently, and order is not the property. */
function renderedIds(scope: string): Set<string> {
  return new Set(
    Array.from(document.querySelectorAll(`${scope} [data-zoc-session-row]`), (row) =>
      row.getAttribute("data-zoc-session-row"),
    ).filter((id): id is string => id !== null),
  );
}

const SWITCHER_LIST = "[data-zoc-session-switcher-panel]";
const PANEL = '[data-surface="panel"]';
const VIEW = '[data-surface="view"]';

/**
 * The nodes whose identity says a surface did not remount.
 *
 * Each is a node the *surface* renders, never one of this harness's wrappers: a wrapper survives by
 * construction, so asserting on it would make R35.3 unfalsifiable. `> *` is each surface's own root
 * element, which React replaces if the component is remounted rather than re-rendered.
 */
const MOUNT_NODES = [
  `${SWITCHER_LIST} [data-zoc-session-list]`,
  `${PANEL} > *`,
  `${VIEW} > *`,
] as const;

function requireNode(selector: string): Element {
  const node = document.querySelector(selector);
  if (node === null) throw new Error(`no ${selector}`);
  return node;
}

describe("Property 86 — one Session_Store, three agreeing Session_Lists", () => {
  it("keeps every rendered Session_List in agreement across a lifecycle sequence, without remounting", async () => {
    await fc.assert(
      fc.asyncProperty(lifecycleActions, async (scenario) => {
        const root = scenario.sessions[0].workspace_root ?? "";
        resetStore(root);
        useApp.setState({
          sessions: [...scenario.sessions],
          activeSessionId: scenario.sessions[0].id,
        });

        render(<Surfaces onSelect={vi.fn()} />);
        try {
          // The switcher's list is only in the DOM while its menu is open, and Radix opens a
          // `DropdownMenu` from a pointer sequence jsdom does not synthesise — Enter on the focused trigger
          // is what works and what a keyboard user does anyway. It stays open across store updates, which
          // is what makes the no-remount half of this property observable on that surface at all.
          const trigger = requireNode("[data-zoc-session-switcher]") as HTMLElement;
          trigger.focus();
          fireEvent.keyDown(trigger, { key: "Enter" });

          const mounted = MOUNT_NODES.map((selector) => requireNode(selector));

          const agree = (): void => {
            const live = useApp.getState().sessions;
            const every = new Set(live.map((s) => s.id));
            const openHere = new Set(
              live
                .filter((s) => s.workspace_root === root && s.status !== "closed")
                .map((s) => s.id),
            );
            expect(renderedIds(SWITCHER_LIST)).toEqual(openHere);
            expect(renderedIds(PANEL)).toEqual(every);
            expect(renderedIds(VIEW)).toEqual(every);
            // R35.3 — a store change re-renders the three surfaces; it never remounts one.
            MOUNT_NODES.forEach((selector, index) => {
              expect(requireNode(selector)).toBe(mounted[index]);
            });
          };

          agree();

          let seq = 0;
          for (const action of scenario.actions) {
            seq += 1;
            const now = new Date(BASE_MS + seq * 60_000).toISOString();
            const live = useApp.getState().sessions;
            // `target` is a selector resolved modulo the live count, so an empty store has nothing to name.
            if (action.kind !== "create" && live.length === 0) continue;

            await act(async () => {
              if (action.kind === "create") {
                // R35.4 — the create decision comes from the one resolver, never from a surface.
                const intent = resolveSessionIntent({
                  trigger: "new-chat",
                  sessions: live,
                  lastActiveId: useApp.getState().activeSessionId || null,
                });
                expect(intent).toEqual({ kind: "fresh" });
                const created: Session = {
                  id: `made_${String(seq)}`,
                  title: action.title.trim() === "" ? "Untitled" : action.title.trim(),
                  status: "active",
                  workspace_root: root,
                  provider: null,
                  model: null,
                  created_at: now,
                  updated_at: now,
                  messages: [],
                  plan: null,
                  tool_calls: [],
                };
                // `fresh`, so: a new Session at the head and an empty transcript — not a resume.
                // The empty transcript is the model applying the intent, not an oracle; `agree()`
                // on the next iteration is what checks the store against the DOM.
                useApp.setState({
                  sessions: [created, ...live],
                  activeSessionId: created.id,
                  agentItems: [],
                });
                return;
              }

              const session = live[action.target % live.length];
              switch (action.kind) {
                case "rename":
                  await useApp.getState().renameSession(session.id, action.title);
                  break;
                case "fork":
                  useApp.setState({
                    sessions: [
                      forkSession(session, action.atMessage, { id: `fork_${String(seq)}`, now }),
                      ...live,
                    ],
                  });
                  break;
                case "duplicate":
                  useApp.setState({
                    sessions: [
                      duplicateSession(session, { id: `dup_${String(seq)}`, now }),
                      ...live,
                    ],
                  });
                  break;
                case "archive": {
                  const archived = archiveSession(session, now);
                  useApp.setState({
                    sessions: live.map((s) => (s.id === session.id ? archived : s)),
                  });
                  break;
                }
                case "delete": {
                  const wasActive = useApp.getState().activeSessionId === session.id;
                  const intent = wasActive
                    ? resolveSessionIntent({
                        trigger: "delete-active",
                        sessions: live.filter((s) => s.id !== session.id),
                        lastActiveId: null,
                        selectedId: session.id,
                      })
                    : null;
                  expect(await useApp.getState().deleteSession(session.id)).toBe(true);
                  if (intent !== null) {
                    expect(intent).toEqual({ kind: "fresh" });
                    // The store acted on that verdict: deleting the active Session does not auto-jump
                    // into a surviving one (R2.5, R35.4).
                    expect(useApp.getState().activeSessionId).toBe("");
                  }
                  break;
                }
              }
            });

            agree();
          }

          // The reuse half of R35.4: a later app-open resolves through the same resolver, and resumes only
          // a Session that survived the sequence.
          const final = useApp.getState().sessions;
          const activeId = useApp.getState().activeSessionId;
          expect(
            resolveSessionIntent({
              trigger: "app-open",
              sessions: final,
              lastActiveId: activeId === "" ? null : activeId,
            }),
          ).toEqual(
            final.some((s) => s.id === activeId)
              ? { kind: "resume", sessionId: activeId }
              : { kind: "fresh" },
          );
        } finally {
          // 200 iterations in one `it`: without this the trees stack up and every `document.querySelector`
          // answers from the first one.
          cleanup();
        }
      }),
      { numRuns: 200 },
    );

    // Radix's `FocusScope` restores focus from a `setTimeout` on unmount, and the last iteration's
    // `cleanup()` schedules one with nothing after it to flush it — it would then fire against a torn-down
    // environment and be reported as an unhandled error. One tick is enough.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }, 300_000);
});
