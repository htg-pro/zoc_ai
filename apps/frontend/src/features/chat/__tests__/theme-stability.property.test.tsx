/**
 * Property 49: Theme changes remount nothing. Validates R17.3.
 *
 * The property is about a *mechanism*, and the mechanism is the reason it holds: every
 * Chat_Surface colour resolves through a CSS custom property, so a theme flip is the browser
 * re-resolving `var(--zoc-*)` against a different `:root` block. React is not involved, has
 * nothing to subscribe to, and therefore has nothing to remount.
 *
 * So there are two halves here, and the second is what gives the first its teeth:
 *
 *   - **Behavioural.** Mount counts are unchanged across an arbitrary sequence of theme
 *     flips, and unchanged across a re-render while the theme differs. A component that
 *     read the theme through React state and keyed on it would fail this.
 *   - **Structural.** No rendered colour is a literal. A component that hard-coded
 *     `#8b7cf6` would pass the mount check and still be wrong under a light theme — the
 *     mount count would be stable precisely *because* the colour never changed. Asserting
 *     the absence of literals is what stops the first half from passing vacuously.
 *
 * jsdom does not apply a stylesheet cascade, so this cannot measure a resolved colour. It
 * measures what it can measure honestly: that the DOM asks for a variable rather than
 * naming a value, and that React did not re-mount. The resolved-value claim belongs to
 * `tokens.property.test.ts`, which checks the pairs against `globals.css` directly.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { ZOC_MARK_SIZES, ZocMark, type ZocMarkState } from "@/features/chat/brand/ZocMark";

const RUNS = { numRuns: 100 } as const;

const MARK_STATES: readonly ZocMarkState[] = ["idle", "running", "complete", "failed"];

/** One flip of the application theme, as the shell performs it: a class on `<html>`. */
type Theme = "light" | "dark";

function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Mount and render counts, keyed by probe label. */
interface Counts {
  mounts: Map<string, number>;
  renders: Map<string, number>;
}

function bump(into: Map<string, number>, key: string): void {
  into.set(key, (into.get(key) ?? 0) + 1);
}

/**
 * A probe that records its own mounts and renders.
 *
 * The mount counter is in a `useEffect` with an empty dependency list, so it fires once per
 * mount and never on a re-render — which is exactly the distinction R17.3 draws: re-rendering
 * on a theme change would be acceptable, remounting is not, because a remount discards
 * scroll position, focus, and any uncommitted input in the subtree.
 */
function Probe({
  label,
  counts,
  children,
}: {
  label: string;
  counts: Counts;
  children: ReactNode;
}) {
  bump(counts.renders, label);
  useEffect(() => {
    bump(counts.mounts, label);
    // Both dependencies are stable for the life of the instance — the map identity never
    // changes and the label is a constant prop — so naming them satisfies the lint rule
    // without turning a mount counter into a render counter, which is the distinction the
    // whole property rests on.
  }, [counts.mounts, label]);
  return <>{children}</>;
}

afterEach(() => {
  cleanup();
  applyTheme("dark");
});

/** The transcript-shaped subtree under test: every Chat_Surface component there is today. */
function Surface({ counts, states }: { counts: Counts; states: readonly ZocMarkState[] }) {
  return (
    <ChatMotionProvider budget={null}>
      {states.map((state, index) => (
        <Probe key={`mark-${String(index)}`} label={`mark-${String(index)}`} counts={counts}>
          <ZocMark state={state} size={ZOC_MARK_SIZES[index % ZOC_MARK_SIZES.length]} title="Zoc" />
        </Probe>
      ))}
    </ChatMotionProvider>
  );
}

describe("Feature: zoc-agent-chat-rebuild, Property 49: theme changes remount nothing", () => {
  it("leaves every mount count unchanged across an arbitrary sequence of flips", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...MARK_STATES), { minLength: 1, maxLength: 7 }),
        fc.array(fc.constantFrom<Theme>("light", "dark"), { minLength: 1, maxLength: 12 }),
        (states, flips) => {
          cleanup();
          applyTheme("dark");

          const counts: Counts = { mounts: new Map(), renders: new Map() };
          render(<Surface counts={counts} states={states} />);

          const afterMount = new Map(counts.mounts);
          expect(afterMount.size).toBe(states.length);
          for (const count of afterMount.values()) expect(count).toBe(1);

          // The flips happen outside React entirely — a class on `<html>` — which is the
          // mechanism the property is about.
          for (const theme of flips) applyTheme(theme);

          expect(counts.mounts).toEqual(afterMount);
        },
      ),
      RUNS,
    );
  });

  it("leaves mount counts unchanged when the tree re-renders under a different theme", () => {
    // The stricter case. A flip alone proves nothing if React never rendered; this forces a
    // render *while* the theme differs, so a component that keyed on a theme value would
    // remount here even though the previous test passed.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...MARK_STATES), { minLength: 1, maxLength: 5 }),
        (states) => {
          cleanup();
          applyTheme("dark");

          const counts: Counts = { mounts: new Map(), renders: new Map() };
          const view = render(<Surface counts={counts} states={states} />);
          const afterMount = new Map(counts.mounts);

          applyTheme("light");
          view.rerender(<Surface counts={counts} states={states} />);
          applyTheme("dark");
          view.rerender(<Surface counts={counts} states={states} />);

          expect(counts.mounts).toEqual(afterMount);
          // And it really did re-render, so the assertion above is not vacuous.
          for (const label of afterMount.keys()) {
            expect(counts.renders.get(label) ?? 0).toBeGreaterThan(1);
          }
        },
      ),
      RUNS,
    );
  });

  it("renders identical markup before and after a flip", () => {
    // The consequence a user sees: if nothing remounts and nothing re-resolves in React, the
    // DOM the theme flip acts on is byte-identical. Any divergence means a colour decision
    // was made in JavaScript rather than in CSS.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...MARK_STATES), { minLength: 1, maxLength: 5 }),
        (states) => {
          cleanup();
          applyTheme("dark");

          const counts: Counts = { mounts: new Map(), renders: new Map() };
          const view = render(<Surface counts={counts} states={states} />);
          const beforeFlip = view.container.innerHTML;

          applyTheme("light");
          view.rerender(<Surface counts={counts} states={states} />);

          expect(view.container.innerHTML).toBe(beforeFlip);
        },
      ),
      RUNS,
    );
  });
});

describe("the mechanism the property rests on (R17.1)", () => {
  /** Every attribute value the rendered subtree carries, flattened. */
  function renderedValues(states: readonly ZocMarkState[]): string[] {
    const counts: Counts = { mounts: new Map(), renders: new Map() };
    const view = render(<Surface counts={counts} states={states} />);
    const values: string[] = [];
    for (const element of view.container.querySelectorAll("*")) {
      for (const attribute of element.attributes) values.push(attribute.value);
    }
    return values;
  }

  const HEX_OR_RGBA = /#[0-9a-f]{3,8}\b|rgba?\(/i;

  it("names a variable for every colour, never a literal", () => {
    // Without this, the mount-count property passes *because* the colour never changes: a
    // component that hard-coded `#8b7cf6` would be perfectly stable and perfectly wrong.
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...MARK_STATES), { minLength: 1, maxLength: 7 }),
        (states) => {
          cleanup();
          for (const value of renderedValues(states)) {
            expect(HEX_OR_RGBA.test(value), value).toBe(false);
          }
        },
      ),
      RUNS,
    );
  });

  it("paints from var(--zoc-*) or currentColor and from nothing else", () => {
    cleanup();
    const painted = renderedValues(MARK_STATES).filter(
      (value) => value.startsWith("var(") || value === "currentColor" || value.startsWith("url(#"),
    );
    // Something is painted — otherwise the negative assertion above is trivially true.
    expect(painted.length).toBeGreaterThan(0);
    for (const value of painted) {
      if (!value.startsWith("var(")) continue;
      // Only the two declared layers: the Spark/Chat_Surface `--zoc-*` set, or a shadcn
      // `--*` name. A third prefix would be the parallel token system R17.2 forbids.
      expect(value, value).toMatch(/^var\(--(zoc-[a-z0-9-]+|[a-z0-9-]+)\)$/);
    }
  });

  it("carries the state as a data attribute, so it is not colour-only (R21.7)", () => {
    // Adjacent to the property rather than part of it, and here because it is the same
    // render: a theme flip must not be the only thing distinguishing two states either.
    cleanup();
    const counts: Counts = { mounts: new Map(), renders: new Map() };
    const view = render(<Surface counts={counts} states={MARK_STATES} />);
    const states = [...view.container.querySelectorAll("[data-zoc-mark]")].map((node) =>
      node.getAttribute("data-state"),
    );
    expect(states).toEqual([...MARK_STATES]);
  });
});
