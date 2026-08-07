/**
 * Property 54: Every interactive control is keyboard reachable and focus-visible. R21.1, task 23.2.
 *
 * *For any* Chat_Surface component, across any of the states it renders: every control a user can
 * operate is reachable by keyboard, sits in document tab order, carries an accessible name, and shows
 * a focus indicator drawn from the token layer when focused.
 *
 * ## The four ways R21.1 breaks, and why each is a separate assertion
 *
 * 1. **`tabIndex={-1}` on an operable control.** The control still works with a mouse and has left
 *    the keyboard entirely. This is the failure that is invisible in review, because nothing about
 *    the rendered pixel changes.
 * 2. **A positive `tabIndex`.** One `tabIndex={1}` anywhere hoists that control to the front of the
 *    document's tab order and pushes every implicit-order control behind *all* of them. It is a
 *    whole-page regression authored in one component.
 * 3. **No accessible name.** An icon-only button reaches a screen-reader user as "button", which is
 *    reachable and unusable. The chat surface is dense with icon-only controls — cancel, retry,
 *    expand, remove-chip — so this is the most likely of the four.
 * 4. **No focus indicator.** `focus-visible:outline-none` with nothing replacing it is the classic
 *    form, and it is *worse* than the browser default it overrode.
 *
 * ## Why the focus indicator is asserted as a class and not a computed style
 *
 * jsdom does not evaluate Tailwind: `getComputedStyle` on a `focus-visible:ring-2` element returns
 * nothing useful, and `:focus-visible` does not match under a synthetic focus. So the assertion is
 * that the control *declares* an indicator from the closed set the token layer provides — the
 * `focus-visible:ring-*` utilities pointing at a `--zoc-*` variable, or the shared `.zoc-focus-ring`
 * utility. That is checkable, and it catches the real regression, which is a control that declares
 * `focus-visible:outline-none` and stops there.
 *
 * ponytail: a computed-style assertion needs a real browser. This pins the declaration; promote to
 * the `@perf` browser harness if a ring ever regresses with the class still present.
 *
 * ## What is deliberately not required to be tabbable
 *
 * Controls inside a **managed-focus widget** — a listbox, menu, or radiogroup — are reached with the
 * arrow keys from a single tab stop, which is the ARIA pattern for those roles and is *more* usable
 * than making twelve model rows twelve tab stops. `isManaged` names them, and they are still held to
 * the accessible-name rule, because "reached by arrows" and "announced as nothing" are independent.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { RunStatusPill, type RunPillState } from "@/features/chat/header/RunStatusPill";
import { ModelPicker } from "@/features/chat/header/ModelPicker";
import { EffortControl } from "@/features/chat/composer/EffortControl";
import { ToolEntry } from "@/features/chat/timeline/ToolEntry";
import { HunkRow } from "@/features/chat/review/HunkRow";
import { EmptyState } from "@/features/chat/EmptyState";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import type { ToolEntryModel, ToolEntryState } from "@/features/chat/timeline/tool-entry-model";
import type { HunkDecision } from "@/features/chat/store";
import type { Hunk, HunkAction, ToolKind } from "@zoc-studio/shared-types";

afterEach(cleanup);

// ── The rules ─────────────────────────────────────────────────────────

/** Everything a user can operate, before any exemption is applied. */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "[role=button]",
  "[role=radio]",
  "[role=option]",
  "[role=menuitem]",
  "[role=checkbox]",
  "[tabindex]",
].join(",");

/** Roles whose children are reached with arrows from one tab stop, not with Tab. */
const MANAGED_CONTAINER = "[role=listbox],[role=menu],[role=radiogroup],[role=tablist],[cmdk-list]";

function isManaged(element: Element): boolean {
  return (
    element.parentElement?.closest(MANAGED_CONTAINER) !== null &&
    element.closest(MANAGED_CONTAINER) !== null
  );
}

/**
 * The focus indicators the token layer sanctions. A ring utility that points at a `--zoc-*` variable,
 * or the shared class. `focus-visible:outline-none` on its own is the absence this looks for.
 */
function declaresFocusIndicator(element: Element): boolean {
  const className = element.getAttribute("class") ?? "";
  if (className.includes("zoc-focus-ring")) return true;
  // The ring must be *drawn*, not merely sized: `focus-visible:ring-2` with no colour inherits the
  // Tailwind default, which is not a token.
  return (
    /focus-visible:ring-\d/.test(className) &&
    /focus-visible:ring-\[color:var\(--zoc-/.test(className)
  );
}

/** aria-label, else the referenced label's text, else the visible text, else the title. */
function accessibleName(element: Element, root: HTMLElement): string {
  const label = element.getAttribute("aria-label");
  if (label !== null && label.trim() !== "") return label.trim();

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    const referenced = labelledBy
      .split(/\s+/)
      .map((id) => root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? "")
      .join(" ")
      .trim();
    if (referenced !== "") return referenced;
  }

  const text = (element.textContent ?? "").trim();
  if (text !== "") return text;

  return (element.getAttribute("title") ?? "").trim();
}

/** A control that is present but not operable is not required to be reachable. */
function isInert(element: Element): boolean {
  return (
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true" ||
    element.getAttribute("aria-hidden") === "true" ||
    element.closest("[aria-hidden=true]") !== null
  );
}

/**
 * Run every R21.1 rule over one rendered tree, naming the component so a failure says which one.
 */
function expectKeyboardReachable(component: string, root: HTMLElement): void {
  const controls = [...root.querySelectorAll(INTERACTIVE_SELECTOR)].filter(
    (element) => !isInert(element),
  );

  expect(controls.length, `${component}: rendered no interactive control to check`).toBeGreaterThan(
    0,
  );

  for (const control of controls) {
    const name = accessibleName(control, root);
    const where = `${component}: <${control.tagName.toLowerCase()}> "${name || "(unnamed)"}"`;

    // Rule 3 first: an unnamed control is the failure most likely to be present, and reporting it
    // before the tab-order rules means the message identifies the element by something other than
    // "(unnamed)".
    expect(
      name,
      `${where} has no accessible name — it reaches a screen reader as "button" (R21.1)`,
    ).not.toBe("");

    const tabIndex = control.getAttribute("tabindex");
    if (tabIndex !== null) {
      const value = Number(tabIndex);
      // Rule 2.
      expect(
        value,
        `${where} sets tabindex="${tabIndex}", which hoists it ahead of every implicit-order control ` +
          `on the page (R21.1)`,
      ).toBeLessThanOrEqual(0);

      // Rule 1 — waived only inside a managed-focus widget, where -1 is the roving pattern.
      if (value < 0 && !isManaged(control)) {
        expect.fail(
          `${where} sets tabindex="-1" outside a listbox/menu/radiogroup, so it is operable with a ` +
            `mouse and unreachable by keyboard (R21.1)`,
        );
      }
    }

    // Rule 4.
    expect(
      declaresFocusIndicator(control),
      `${where} declares no token-layer focus indicator — add ` +
        `\`focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]\` (R21.1)`,
    ).toBe(true);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────

function model(overrides: Partial<ModelChoice> = {}): ModelChoice {
  return {
    provider: "anthropic",
    providerLabel: "Anthropic",
    modelId: "claude-sonnet-5",
    label: "Sonnet 5",
    requiresKey: true,
    hasKey: true,
    local: false,
    ...overrides,
  } as ModelChoice;
}

const PATCH = "@@ -10,2 +10,3 @@\n context\n-removed\n+added\n+also added\n";

function hunk(): Hunk {
  return { hunkId: "h1", oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, patch: PATCH };
}

function toolEntry(state: ToolEntryState): ToolEntryModel {
  return {
    toolCallId: "call_1",
    toolName: "workspace_read",
    kind: "read" as ToolKind,
    state,
    durationMs: 120,
    ...(state === "failed" ? { error: { code: "tool_failed", message: "no such file" } } : {}),
  } as ToolEntryModel;
}

const RUN_STATES: readonly RunPillState[] = [
  "idle",
  "queued",
  "running",
  "awaiting-approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
];

const HUNK_DECISIONS: readonly HunkDecision[] = ["undecided", "accepted", "rejected"];
const HUNK_ACTIONS: readonly HunkAction[] = ["create", "modify", "delete", "rename"];
const TOOL_STATES: readonly ToolEntryState[] = ["running", "succeeded", "failed", "denied"];

// ── Properties ────────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 54: every interactive control is keyboard reachable", () => {
  it("holds for the run pill in every run state, including its cancel control (R21.1)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...RUN_STATES), (state) => {
        cleanup();
        const { container } = render(
          <ChatMotionProvider>
            <RunStatusPill state={state} elapsedMs={14_000} onCancel={() => {}} />
          </ChatMotionProvider>,
        );
        // The pill renders no control at all in the settled states; only the active ones offer cancel.
        if (container.querySelectorAll(INTERACTIVE_SELECTOR).length === 0) return;
        expectKeyboardReachable(`RunStatusPill(${state})`, container);
      }),
      { numRuns: RUN_STATES.length },
    );
  });

  it("holds for a tool timeline entry in every tool state (R21.1, R21.4)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOOL_STATES), fc.boolean(), (state, open) => {
        cleanup();
        const { container } = render(
          <ChatMotionProvider>
            <ToolEntry
              entry={toolEntry(state)}
              open={open}
              onOpenChange={() => {}}
              onRetry={() => {}}
            />
          </ChatMotionProvider>,
        );
        // An entry with nothing to disclose yet — a call still running, with no result to show —
        // renders no control at all. That is correct, not a reachability failure.
        if (container.querySelectorAll(INTERACTIVE_SELECTOR).length === 0) return;
        expectKeyboardReachable(`ToolEntry(${state}, open=${String(open)})`, container);
      }),
      { numRuns: TOOL_STATES.length * 2 },
    );
  });

  it("holds for a diff hunk under every action and decision (R21.1, R21.5)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...HUNK_ACTIONS),
        fc.constantFrom(...HUNK_DECISIONS),
        fc.boolean(),
        (action, decision, expanded) => {
          cleanup();
          const { container } = render(
            <ChatMotionProvider>
              <HunkRow
                path="src/a.ts"
                action={action}
                hunk={hunk()}
                decision={decision}
                expanded={expanded}
                onExpandedChange={() => {}}
                onDecide={() => {}}
              />
            </ChatMotionProvider>,
          );
          expectKeyboardReachable(`HunkRow(${action}/${decision})`, container);
        },
      ),
      { numRuns: 12 },
    );
  });

  it("holds for the composer's effort control (R21.1)", () => {
    const { container } = render(
      <ChatMotionProvider>
        <EffortControl value="balanced" onChange={() => {}} />
      </ChatMotionProvider>,
    );
    expectKeyboardReachable("EffortControl", container);
  });

  it("holds for the model picker's trigger (R21.1)", () => {
    const { container } = render(
      <ChatMotionProvider>
        <ModelPicker
          models={[model()]}
          selected={model()}
          onSelect={() => {}}
          onAddKey={() => {}}
        />
      </ChatMotionProvider>,
    );
    expectKeyboardReachable("ModelPicker", container);
  });

  it("holds for the empty state, with and without a usable model (R21.1, R13.3)", () => {
    fc.assert(
      fc.property(fc.boolean(), (hasKey) => {
        cleanup();
        const { container } = render(
          <ChatMotionProvider>
            <EmptyState
              workspaceRoot="/w"
              model={model({ hasKey })}
              onPick={() => {}}
              onAddKey={() => {}}
            />
          </ChatMotionProvider>,
        );
        expectKeyboardReachable(`EmptyState(hasKey=${String(hasKey)})`, container);
      }),
      { numRuns: 2 },
    );
  });
});
