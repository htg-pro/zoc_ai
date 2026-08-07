/**
 * Property 53: Every state is distinguishable without colour. R21.7, task 23.3.
 *
 * *For any* two distinct states drawn from the same family, the two renders differ somewhere other
 * than in colour. The three families 23.1 names are the ones with a state-dependent tint: run state
 * (`RunStatusPill`), tool state (`ToolEntry`), and hunk decision (`HunkRow`).
 *
 * ## What "without colour" means here, mechanically
 *
 * The test builds a **colour-blind signature** of a render: the text content, plus the state-bearing
 * attributes (`data-*`, `aria-pressed`, `aria-label`), plus the SVG path geometry — and explicitly
 * *not* `style`, `fill`, `stroke`, or `color`. Two states whose signatures are equal are, to a user
 * who cannot tell the two tints apart, the same state. So the property is pairwise distinctness of
 * that signature across each family, which is R21.7 restated as something a machine can decide.
 *
 * Stripping colour rather than asserting the presence of a label is the point. A test that checked
 * "each state renders some text" passes when two states render the *same* text and differ only by
 * tint — which is exactly the failure R21.7 exists to prevent, and the one a new state added to a
 * colour map and forgotten in a label map produces.
 *
 * ## Why the geometry is in the signature and the fill is not
 *
 * `ToolNode` and `ActionBadge` carry state as *shape*, and a shape is a `d` attribute. Dropping
 * `fill` while keeping `d` is what lets a family satisfy R21.7 by shape alone — which the tool
 * timeline partly does: `nodeShapeOf` returns a distinct square for `failed` and otherwise keys the
 * shape off the tool's *kind*, so `running`, `succeeded`, and `denied` share a node glyph. They are
 * distinguishable because `ToolEntry` renders `stateLabelOf` as text and puts it in the accessible
 * name — which is precisely the thing this test would catch the removal of.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { RunStatusPill, type RunPillState } from "@/features/chat/header/RunStatusPill";
import { ToolEntry } from "@/features/chat/timeline/ToolEntry";
import { HunkRow } from "@/features/chat/review/HunkRow";
import { ActionBadge } from "@/features/chat/review/ActionBadge";
import type { ToolEntryModel, ToolEntryState } from "@/features/chat/timeline/tool-entry-model";
import type { HunkDecision } from "@/features/chat/store";
import type { Hunk, HunkAction, ToolKind } from "@zoc-studio/shared-types";

afterEach(cleanup);

// ── The colour-blind signature ────────────────────────────────────────

/**
 * Attributes a *user* can perceive: the accessible name and pressed/checked state, which reach a
 * screen reader, and the geometry, which reaches the eye. `style` is absent on purpose — it is where
 * every tint in this codebase lives, since the token layer is read through `var(--zoc-*)` inline
 * rather than through classes.
 *
 * **`data-*` is deliberately excluded, and that exclusion is the whole test.** Nearly every node in
 * this feature carries `data-state`, `data-decision`, or `data-zoc-run-pill` whose *value is the
 * state's own name* — so including them makes pairwise distinctness true by construction, for every
 * family, forever. Verified by mutation: with `data-*` in the signature, collapsing all four of
 * `stateLabelOf`'s words to one string still passed. A `data-` attribute is a hook for a stylesheet
 * and a test; R21.7 is about what a person can perceive, and no one perceives an attribute.
 */
const SIGNIFICANT_ATTRIBUTES = [
  "aria-label",
  "aria-pressed",
  "aria-checked",
  "aria-disabled",
  "title",
  "d",
  "points",
  "r",
  "width",
  "height",
];

function isSignificant(name: string): boolean {
  return SIGNIFICANT_ATTRIBUTES.includes(name);
}

/**
 * Everything about a render that survives the loss of colour perception.
 *
 * Element *shape* of the tree is included via the tag names, because a state that swaps a filled
 * circle for an outlined one changes `fill` (dropped) but also `stroke-width` and the element set —
 * and a family that distinguished its states only by a `fill` swap should fail this test.
 */
function colourBlindSignature(root: HTMLElement): string {
  const parts: string[] = [];

  const walk = (node: Element): void => {
    const attributes = [...node.attributes]
      .filter((attribute) => isSignificant(attribute.name))
      .map((attribute) => `${attribute.name}=${attribute.value}`)
      .sort();
    parts.push(`<${node.tagName.toLowerCase()} ${attributes.join(" ")}>`);
    for (const child of node.children) walk(child);
  };

  walk(root);
  // Text last, so a signature is "structure then words" and a diff points at whichever changed.
  parts.push(`text:${(root.textContent ?? "").trim()}`);
  return parts.join("|");
}

/**
 * Assert that no two distinct states share a signature, and report *which* pair collided — the
 * message is the whole value of the test when it fails, because "two states look alike" is useless
 * without knowing which two.
 */
function expectPairwiseDistinct<S extends string>(
  family: string,
  states: readonly S[],
  signatureOf: (state: S) => string,
): void {
  const seen = new Map<string, S>();
  for (const state of states) {
    const signature = signatureOf(state);
    const collision = seen.get(signature);
    expect(
      collision,
      `${family}: "${String(state)}" and "${String(collision)}" are indistinguishable without colour — ` +
        `their renders differ only in tint. Give one of them a distinct label or shape (R21.7).`,
    ).toBeUndefined();
    seen.set(signature, state);
  }
}

// ── Family 1: run state ───────────────────────────────────────────────

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

// ── Family 2: tool state ──────────────────────────────────────────────

const TOOL_STATES: readonly ToolEntryState[] = ["running", "succeeded", "failed", "denied"];

const TOOL_KINDS: readonly ToolKind[] = ["read", "edit", "execute", "search"] as ToolKind[];

function toolEntry(state: ToolEntryState, kind: ToolKind): ToolEntryModel {
  return {
    toolCallId: "call_1",
    toolName: "workspace_read",
    kind,
    state,
    durationMs: 120,
  };
}

// ── Family 3: hunk decision ───────────────────────────────────────────

const HUNK_DECISIONS: readonly HunkDecision[] = ["undecided", "accepted", "rejected"];

const HUNK_ACTIONS: readonly HunkAction[] = ["create", "modify", "delete", "rename"];

const PATCH = "@@ -10,2 +10,3 @@\n context\n-removed\n+added\n+also added\n";

function hunk(): Hunk {
  return { hunkId: "h1", oldStart: 10, oldLines: 2, newStart: 10, newLines: 3, patch: PATCH };
}

// ── Properties ────────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 53: every state is distinguishable without colour", () => {
  it("gives each run state a signature no other run state shares (R21.7)", () => {
    // The elapsed clock is held fixed: a state that differed only by the time beside it would pass
    // for the wrong reason, and the clock is not a state cue.
    expectPairwiseDistinct("run state", RUN_STATES, (state) => {
      const { container, unmount } = render(
        <ChatMotionProvider>
          <RunStatusPill state={state} elapsedMs={14_000} />
        </ChatMotionProvider>,
      );
      const signature = colourBlindSignature(container);
      unmount();
      return signature;
    });
  });

  it("gives each tool state a signature no other tool state shares, for any tool kind (R21.7)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TOOL_KINDS), (kind) => {
        // Held fixed across the four states for the same reason the clock is above: the duration is
        // not a state cue, and letting it vary would mask a collision.
        expectPairwiseDistinct(`tool state (kind=${String(kind)})`, TOOL_STATES, (state) => {
          const { container, unmount } = render(
            <ChatMotionProvider>
              <ToolEntry entry={toolEntry(state, kind)} />
            </ChatMotionProvider>,
          );
          const signature = colourBlindSignature(container);
          unmount();
          return signature;
        });
      }),
      { numRuns: TOOL_KINDS.length },
    );
  });

  it("gives each hunk decision a signature no other decision shares, for any file action (R21.7)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...HUNK_ACTIONS), (action) => {
        expectPairwiseDistinct(
          `hunk decision (action=${String(action)})`,
          HUNK_DECISIONS,
          (decision) => {
            const { container, unmount } = render(
              <ChatMotionProvider>
                <HunkRow
                  path="src/a.ts"
                  action={action}
                  hunk={hunk()}
                  decision={decision}
                  expanded={false}
                  onExpandedChange={() => {}}
                  onDecide={() => {}}
                />
              </ChatMotionProvider>,
            );
            const signature = colourBlindSignature(container);
            unmount();
            return signature;
          },
        );
      }),
      { numRuns: HUNK_ACTIONS.length },
    );
  });

  it("distinguishes the four file actions by shape, not only by letter (R10.11, R21.7)", () => {
    // The badge is the one place where the non-colour carrier is geometry rather than a word, so the
    // `d` attributes are asserted to differ directly — a badge that drew one circle in four tints
    // would satisfy "has a letter" and still fail a user reading shapes at 8px.
    const geometryOf = (action: HunkAction): string => {
      const { container, unmount } = render(
        <ChatMotionProvider>
          <ActionBadge action={action} />
        </ChatMotionProvider>,
      );
      // The glyph *children*, not the `<svg>` itself: the element carries `data-zoc-action-shape`,
      // which names the action and would make every signature trivially distinct without saying
      // anything about what is drawn.
      const svg = container.querySelector("svg");
      expect(svg, `no badge rendered for "${String(action)}"`).not.toBeNull();
      const geometry = svg?.innerHTML ?? "";
      unmount();
      // Strip the colour the glyphs paint from, so two shapes cannot be told apart by their tint.
      return geometry.replace(/(fill|stroke)="[^"]*"/g, "");
    };

    expectPairwiseDistinct("file action badge", HUNK_ACTIONS, geometryOf);
  });
});
