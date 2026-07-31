/**
 * Property 19: The active permission mode is always visible. R11.1.
 *
 * *For any* header state — any active mode, any run state, any session title and model name however long,
 * with or without a context figure, with or without a model selected — the **Approval** control is in the
 * document, names the active mode, and marks exactly that one active.
 *
 * ## Why the property needs a second, non-rendered clause
 *
 * "Visible at all times" has two failure modes and a render-only test catches one of them. The first is a
 * control that is conditionally *rendered* — hidden while a Run streams, dropped when no model is selected —
 * and the generated prop domain below covers it. The second is a control that is rendered and then hidden by
 * a container query at some width, which jsdom cannot observe at all: it has no layout, so `@container` rules
 * never apply and every element is equally "visible".
 *
 * So the collapse clause is asserted against `globals.css` as text, the way `tokens.property.test.ts` checks
 * the mirrored token values. What it asserts is a *negative*: no rule inside the chat header's container
 * queries touches the approval control. That is stronger than checking the three rules that do collapse,
 * because it fails on a rule nobody has written yet — which is exactly the regression R11.1 is exposed to,
 * a later width pass adding `display: none` to the row that must never have one.
 *
 * ## Why the run states are enumerated rather than sampled
 *
 * Eight states is the whole domain, and the two that would plausibly hide the control are `running` (a busy
 * header wanting room for the pill) and `awaiting-approval` (where the mode is precisely what the user is
 * about to reason about). Sampling could miss either.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";

import { ChatHeader } from "@/features/chat/header/ChatHeader";
import { PERMISSION_MODE_LABELS, modelChoice } from "@/features/chat/header/model-catalogue";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import type { RunPillState } from "@/features/chat/header/RunStatusPill";
import { PERMISSION_MODES, type PermissionMode } from "./arbitraries";

const RUNS = { numRuns: 120 } as const;

const GLOBALS_CSS = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

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

const model = (id: string): ModelChoice =>
  modelChoice({
    provider: "anthropic",
    providerLabel: "Anthropic",
    model: { id, name: `Claude ${id}`, contextWindow: 200_000 },
    requiresKey: true,
    hasKey: true,
    local: false,
    contextLimit: 200_000,
  });

interface HeaderState {
  readonly mode: PermissionMode;
  readonly runState: RunPillState;
  readonly sessionTitle: string;
  readonly hasModel: boolean;
  readonly hasContextMeter: boolean;
  readonly runElapsedMs: number;
  readonly tokensPerSecond: number | null;
}

const headerState: fc.Arbitrary<HeaderState> = fc.record({
  mode: fc.constantFrom(...PERMISSION_MODES),
  runState: fc.constantFrom(...RUN_STATES),
  // Includes a title long enough to force the truncation rule, which is the case
  // where a control gets pushed out of a flex row rather than hidden by a rule.
  sessionTitle: fc.oneof(
    fc.constant(""),
    fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{0,30}$/),
    fc.constant("A session title long enough to crowd every other control out of the row"),
  ),
  hasModel: fc.boolean(),
  hasContextMeter: fc.boolean(),
  runElapsedMs: fc.integer({ min: 0, max: 3_600_000 }),
  tokensPerSecond: fc.option(fc.double({ min: 1, max: 300, noNaN: true }), { nil: null }),
});

function renderHeader(state: HeaderState): void {
  const models = [model("opus-5"), model("sonnet-5")];
  render(
    <ChatHeader
      sessionTitle={state.sessionTitle}
      sessionList={{
        sessions: [],
        activeSessionId: null,
        workspaceRoot: "/work/proj",
        onSelect: () => undefined,
      }}
      models={models}
      selectedModel={state.hasModel ? models[0]! : null}
      onSelectModel={() => undefined}
      permissionMode={state.mode}
      onPermissionModeChange={() => undefined}
      runState={state.runState}
      runElapsedMs={state.runElapsedMs}
      tokensPerSecond={state.tokensPerSecond}
      {...(state.hasContextMeter ? { contextMeter: <span>12k / 200k</span> } : {})}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("Feature: zoc-agent-chat-rebuild, Property 19: the active permission mode is always visible", () => {
  it("renders the Approval control in every header state, naming the active mode (R11.1)", () => {
    fc.assert(
      fc.property(headerState, (state) => {
        cleanup();
        renderHeader(state);

        const control = document.querySelector("[data-zoc-approval-control]");
        expect(control).not.toBeNull();
        expect(control?.getAttribute("data-zoc-approval-control")).toBe(state.mode);

        // The label, not just the value: an active mode carried only in an
        // attribute is visible to this test and to nobody using the app.
        const active = document.querySelector(`[data-zoc-approval-item="${state.mode}"]`);
        expect(active?.textContent).toContain(PERMISSION_MODE_LABELS[state.mode]);
        expect(active?.getAttribute("data-state")).toBe("active");
      }),
      RUNS,
    );
  });

  it("marks exactly one mode active and offers all three, in every state", () => {
    fc.assert(
      fc.property(headerState, (state) => {
        cleanup();
        renderHeader(state);

        const items = [...document.querySelectorAll("[data-zoc-approval-item]")];
        expect(items).toHaveLength(PERMISSION_MODES.length);
        expect(items.filter((item) => item.getAttribute("data-state") === "active")).toHaveLength(1);
      }),
      RUNS,
    );
  });

  it("keeps the control reachable by its accessible name, which is the question it answers", () => {
    for (const mode of PERMISSION_MODES) {
      cleanup();
      renderHeader({
        mode,
        runState: "running",
        sessionTitle: "Untitled session",
        hasModel: true,
        hasContextMeter: true,
        runElapsedMs: 14_000,
        tokensPerSecond: 42,
      });

      expect(
        screen.getByRole("tablist", {
          name: "Approval policy — what Zoc AI may do without asking",
        }),
      ).toBeInTheDocument();
    }
  });

  it("survives a run that has no model selected, which is the state a gate would blank", () => {
    // R13.2 blocks *submission* when a cloud model has no key. Blocking the mode
    // display along with it would hide the standing policy at the moment the user
    // is deciding whether to configure a key at all.
    cleanup();
    renderHeader({
      mode: "deny",
      runState: "idle",
      sessionTitle: "",
      hasModel: false,
      hasContextMeter: false,
      runElapsedMs: 0,
      tokensPerSecond: null,
    });

    expect(document.querySelector('[data-zoc-approval-control="deny"]')).not.toBeNull();
    expect(document.querySelector('[data-zoc-approval-item="deny"]')?.textContent).toContain(
      PERMISSION_MODE_LABELS.deny,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 19: the collapse order excludes Approval", () => {
  /** The `@container (...) { ... }` blocks in `globals.css`, as raw text. */
  function containerBlocks(): readonly string[] {
    const blocks: string[] = [];
    const pattern = /@container\s*\([^)]*\)\s*\{/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(GLOBALS_CSS)) !== null) {
      let depth = 1;
      let index = match.index + match[0].length;
      while (index < GLOBALS_CSS.length && depth > 0) {
        if (GLOBALS_CSS[index] === "{") depth += 1;
        if (GLOBALS_CSS[index] === "}") depth -= 1;
        index += 1;
      }
      blocks.push(GLOBALS_CSS.slice(match.index, index));
    }
    return blocks;
  }

  it("declares the header as its own container, which is what makes the rules local to it", () => {
    expect(GLOBALS_CSS).toMatch(/\.zoc-chat-header\s*\{[^}]*container-type:\s*inline-size/);
  });

  it("has no container rule that touches the Approval control at any width (R11.1)", () => {
    const offenders = containerBlocks().filter(
      (block) => block.includes("zoc-approval") || block.includes("data-zoc-approval"),
    );

    // A negative assertion on purpose: it fails on a rule that does not exist
    // yet, which is the regression R11.1 is actually exposed to.
    expect(offenders, `approval control collapsed by: ${offenders.join("\n")}`).toHaveLength(0);
  });

  it("collapses the model name, the context figure, and the session title instead", () => {
    const header = containerBlocks().filter(
      (block) =>
        block.includes("zoc-header-model-name") ||
        block.includes("zoc-header-context") ||
        block.includes("zoc-header-session-title"),
    );

    // The order matters as much as the membership: the model name narrows before
    // the context figure leaves, so the row degrades by losing detail before it
    // loses a fact.
    expect(header.length).toBeGreaterThanOrEqual(2);
    const modelNameWidth = GLOBALS_CSS.indexOf("zoc-header-model-name");
    const contextHidden = GLOBALS_CSS.indexOf("zoc-header-context");
    expect(modelNameWidth).toBeGreaterThan(-1);
    expect(contextHidden).toBeGreaterThan(modelNameWidth);
  });

  it("keeps Conversation_Mode's never-collapse guarantee in a different container (R32.1)", () => {
    // Two containers is what makes "neither mode can push the other out" true by
    // construction rather than by tuning two breakpoints against each other.
    expect(GLOBALS_CSS).toMatch(/\.zoc-composer-controls\s*\{[^}]*container-type:\s*inline-size/);

    // The *item* may never be hidden; its **text** may — below 340px the control
    // keeps three glyphs rather than collapsing into a menu, which is R32.1's
    // "visible at all times" satisfied at the narrowest width rather than dropped.
    const itemsHidden = containerBlocks().filter((block) =>
      /\[data-zoc-mode-item[^\]]*\][^{]*\{[^}]*display:\s*none/.test(block),
    );
    expect(itemsHidden).toHaveLength(0);
    expect(GLOBALS_CSS).toMatch(/\.zoc-mode-item-text\s*\{\s*display:\s*none/);
  });
});
