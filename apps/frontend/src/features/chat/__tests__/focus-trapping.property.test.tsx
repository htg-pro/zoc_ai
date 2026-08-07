/**
 * Property 57: Dialogs trap focus and restore it. R21.6, task 23.4.
 *
 * *For any* of the Chat_Surface's overlay surfaces, opening it moves focus inside, focus cannot leave
 * while it is open, and dismissing it returns focus to the control that opened it.
 *
 * ## Why this is a property and not three unit tests
 *
 * The surfaces are built from three different Radix primitives — `Popover`, `DropdownMenu`, `Dialog` —
 * whose focus defaults are *not* the same. `DropdownMenu` and `Dialog` trap by default; `Popover` does
 * not, and a popover left at its default restores focus while letting Tab walk straight out of it into
 * the page behind. That difference is invisible at the call site: both spellings are `<Popover>` and
 * one of them silently fails R21.6. Quantifying over the surfaces is what makes "every overlay" the
 * assertion rather than "the three overlays someone remembered to test".
 *
 * ## The one deliberate exclusion
 *
 * `MentionPopover` is not in the table. It is a combobox — the listbox half of a control whose focus
 * stays in the textarea, with `aria-activedescendant` naming the highlighted row — so trapping focus
 * would take it off the input the user is mid-sentence in, and the next keystroke would go nowhere.
 * R21.6's actual concern, that focus is never stranded, holds there by focus never moving at all. The
 * exclusion is asserted rather than assumed: the last case pins the textarea keeping focus, so a
 * future `modal` added to that surface fails here instead of silently breaking typing.
 *
 * ## Why Escape and not an outside click
 *
 * Both dismiss, and Escape is the one that matters for R21.6: a user who dismissed with the keyboard
 * has nowhere to go if focus is not returned, whereas a user who clicked outside has already moved
 * their own focus. jsdom also models Escape faithfully and models "a click that landed outside the
 * portal" poorly, so the keyboard path is both the important one and the honest one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { ModelPicker } from "@/features/chat/header/ModelPicker";
import { EffortControl } from "@/features/chat/composer/EffortControl";
import { MentionPopover } from "@/features/chat/composer/MentionPopover";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";

afterEach(cleanup);

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

const MODELS: readonly ModelChoice[] = [
  model(),
  model({ modelId: "claude-opus-5", label: "Opus 5" }),
  model({
    provider: "llamacpp",
    providerLabel: "Local",
    modelId: "qwen",
    label: "Qwen",
    requiresKey: false,
    local: true,
  }),
];

/** The overlay surfaces R21.6 governs, each with the selector that finds its opened content. */
const SURFACES = [
  {
    name: "ModelPicker",
    trigger: "[data-zoc-model-picker]",
    content: "[data-zoc-model-popover]",
    render: () => <ModelPicker models={MODELS} selected={MODELS[0] ?? null} onSelect={() => {}} />,
  },
  {
    name: "EffortControl",
    trigger: "[data-zoc-effort-control]",
    content: "[data-zoc-effort-popover]",
    render: () => <EffortControl value="balanced" onChange={() => {}} />,
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────

const query = (selector: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(selector);

/** Every element the browser would stop on when tabbing, in document order. */
function tabbable(root: ParentNode): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

/**
 * Open a surface by activating its trigger the way a keyboard user would.
 *
 * `click` rather than a synthesised Enter: Radix's trigger listens for `pointerdown`/`click`, and a
 * browser turns Enter on a focused `<button>` into exactly that click. Going through `click` tests the
 * path the component actually implements instead of the one a hand-rolled keydown handler would.
 */
function openSurface(triggerSelector: string): HTMLElement {
  const trigger = query(triggerSelector);
  expect(trigger, `no trigger matched ${triggerSelector}`).not.toBeNull();
  const element = trigger as HTMLElement;
  act(() => {
    element.focus();
    fireEvent.click(element);
  });
  return element;
}

// ── Properties ────────────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, Property 57: overlays trap focus and restore it", () => {
  it("moves focus into the surface when it opens (R21.6)", () => {
    fc.assert(
      fc.property(fc.constantFrom(...SURFACES), (surface) => {
        cleanup();
        render(<ChatMotionProvider>{surface.render()}</ChatMotionProvider>);

        openSurface(surface.trigger);

        const content = query(surface.content);
        expect(content, `${surface.name}: did not open`).not.toBeNull();
        // Radix focuses the content wrapper itself when it holds no autofocus target, so "inside"
        // means the content or a descendant — not necessarily the first item.
        expect(
          content?.contains(document.activeElement) || content === document.activeElement,
          `${surface.name}: focus stayed outside the opened surface`,
        ).toBe(true);
      }),
      { numRuns: SURFACES.length },
    );
  });

  it("opens each surface as a modal layer, which is what traps focus (R21.6)", () => {
    // ## Why this asserts modality rather than walking Tab
    //
    // The direct test — press Tab past the end of the surface, assert focus did not land outside —
    // cannot work in jsdom, and worse, it *passes*. jsdom implements no native Tab traversal: a
    // synthesised `keydown` moves focus nowhere, so `activeElement` never reaches the outside control
    // whether the surface traps or not. Verified by mutation: a Tab-walking version of this test
    // passed with `modal` removed from `ModelPicker`, which is the exact regression it existed to
    // catch. A test that cannot fail is worse than no test, because it is counted.
    //
    // So the assertion is the configuration that produces the trap, which jsdom *does* model: Radix
    // sets `pointer-events: none` on the body for a modal layer and leaves it untouched otherwise,
    // and modality is precisely the switch that turns `FocusScope`'s `trapped` on. The mutation that
    // defeated the Tab walk fails this.
    //
    // ponytail: the real Tab traversal belongs in a browser-driven test. This pins the config that
    // guarantees it — promote to Playwright if the trap ever regresses with modality still set.
    fc.assert(
      fc.property(fc.constantFrom(...SURFACES), (surface) => {
        cleanup();
        render(
          <ChatMotionProvider>
            <button type="button" data-outside="">
              Outside
            </button>
            {surface.render()}
          </ChatMotionProvider>,
        );

        expect(
          document.body.style.pointerEvents,
          `${surface.name}: the body was already inert before the surface opened`,
        ).not.toBe("none");

        openSurface(surface.trigger);
        expect(query(surface.content), `${surface.name}: did not open`).not.toBeNull();

        expect(
          document.body.style.pointerEvents,
          `${surface.name}: opened as a non-modal layer, so Tab walks straight out of it into the ` +
            `page behind. Pass \`modal\` to its <Popover> (R21.6).`,
        ).toBe("none");

        // The surface must still hold something to tab *between*, or trapping is a claim about an
        // empty box.
        const content = query(surface.content);
        expect(
          tabbable(content as HTMLElement).length,
          `${surface.name}: the opened surface holds no focusable control`,
        ).toBeGreaterThan(0);
      }),
      { numRuns: SURFACES.length },
    );
  });

  it("returns focus to the invoking control on dismissal (R21.6)", async () => {
    // Async because Radix restores focus *after* the layer unmounts, on the next task rather than in
    // the Escape handler. Asserting synchronously reads `document.body` and reports a stranded focus
    // that is about to be corrected one tick later — a false failure that says "no restoration" when
    // what actually happened is "not yet".
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...SURFACES), async (surface) => {
        cleanup();
        render(<ChatMotionProvider>{surface.render()}</ChatMotionProvider>);

        const trigger = openSurface(surface.trigger);
        expect(query(surface.content), `${surface.name}: did not open`).not.toBeNull();

        await act(async () => {
          fireEvent.keyDown(document.activeElement ?? document.body, {
            key: "Escape",
            code: "Escape",
          });
        });
        // One more turn of the loop: the unmount above schedules the restore, and this is where it runs.
        await act(async () => {
          await Promise.resolve();
        });

        expect(query(surface.content), `${surface.name}: Escape did not dismiss it`).toBeNull();
        expect(
          document.activeElement,
          `${surface.name}: focus was stranded instead of returning to the trigger`,
        ).toBe(trigger);
      }),
      { numRuns: SURFACES.length },
    );
  });

  it("leaves focus in the composer for the mention combobox, which must not trap (R21.6, R14.4)", () => {
    // The documented exception. Asserted so that adding `modal` to that popover — which would look
    // like closing a gap — fails here instead of silently breaking mid-sentence typing.
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <MentionPopover
          open={open}
          results={[]}
          selected={0}
          onSelect={() => {}}
          onHighlight={() => {}}
          onOpenChange={setOpen}
        >
          <textarea data-composer="" defaultValue="@sr" />
        </MentionPopover>
      );
    }

    render(
      <ChatMotionProvider>
        <Harness />
      </ChatMotionProvider>,
    );

    const textarea = query("[data-composer]");
    expect(textarea).not.toBeNull();
    act(() => {
      textarea?.focus();
    });

    // The popover is already open; focus must still be where the user is typing.
    expect(document.activeElement, "the mention popover pulled focus out of the composer").toBe(
      textarea,
    );
  });
});
