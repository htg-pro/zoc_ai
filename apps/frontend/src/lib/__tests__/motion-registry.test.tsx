// Feature: zoc-agent-chat-rebuild, task 12.3: the extended reduced-motion gate.
// Requirements: 19.1 (transform/opacity/filter only), 19.2 (entrances <= 240 ms),
// 19.3 (the reduced-motion kill-switch), 19.5 (<= 12 concurrent elements).
//
// Example-based cover for the registry, the reduced-motion collapse, and the
// dev-only concurrency counter. Property 51 walks the whole registry and is
// task 12.5's job; these tests pin the specific behaviours the provider and the
// rows depend on, plus the additive-until-26.2 constraint.
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { useEffect } from "react";

import {
  ANIMATABLE_PROPERTIES,
  MOTION_CONCURRENCY_LIMIT,
  MOTION_MAX_ENTRANCE_MS,
  MOTION_VARIANTS,
  MOTION_VARIANT_NAMES,
  animatedPropertiesOf,
  createMotionBudget,
  motionClass,
  resolveMotionVariant,
  transitionClass,
  useMotionBudgetProps,
  useReducedMotion,
} from "../reduced-motion";
import { ChatMotionProvider } from "../reduced-motion-provider";

describe("motion variant registry (task 12.3)", () => {
  it("keeps the legacy class helpers the Legacy_Panel imports (additive until 26.2)", () => {
    // `features/agent/rows.tsx` and `RunCardView.tsx` import these three by
    // name; the registry is added alongside them, not in place of them.
    expect(motionClass("pulse-dot", false)).toBe("motion-pulse-dot");
    expect(motionClass("pulse-dot", true)).toBe("motion-static-pulse-dot");
    expect(transitionClass("row-enter", false)).toBe("zoc-transition-row-enter");
    expect(transitionClass("row-enter", true)).toBe("zoc-transition-reduced");
    expect(typeof useReducedMotion).toBe("function");
  });

  it("names every entry in the inventory", () => {
    expect(MOTION_VARIANT_NAMES).toHaveLength(9);
    expect(MOTION_VARIANT_NAMES).toContain("row-entrance");
    expect(MOTION_VARIANT_NAMES).toContain("caret-blink");
  });

  it("declares only in-budget properties, and the targets agree (R19.1)", () => {
    const declared = MOTION_VARIANTS["node-pulse"].properties;
    expect(declared).toEqual(["opacity", "transform"]);
    // `scale` is a transform shorthand, so the derived set matches.
    expect([...animatedPropertiesOf(MOTION_VARIANTS["node-pulse"].animate)].sort()).toEqual([
      "opacity",
      "transform",
    ]);
    for (const property of declared) {
      expect(ANIMATABLE_PROPERTIES).toContain(property);
    }
  });

  it("reports an out-of-budget target key under its own name", () => {
    // The helper must not launder an unexpected key into "transform", or the
    // R19.1 check it exists for would pass on a height animation.
    expect(animatedPropertiesOf({ height: "auto", opacity: 1 })).toEqual(["height", "opacity"]);
  });

  it("keeps the three entrances inside the 240 ms ceiling (R19.2)", () => {
    const entrances = MOTION_VARIANT_NAMES.filter(
      (name) => MOTION_VARIANTS[name].kind === "entrance",
    );
    expect(entrances).toEqual(["row-entrance", "card-entrance", "dock-entrance"]);
    for (const name of entrances) {
      expect(MOTION_VARIANTS[name].durationMs).toBeLessThanOrEqual(MOTION_MAX_ENTRANCE_MS);
    }
  });

  it("resolves an entrance to its movement and easing when motion is allowed", () => {
    const resolved = resolveMotionVariant("row-entrance", false);
    expect(resolved.initial).toEqual({ opacity: 0, y: 4 });
    expect(resolved.animate).toEqual({ opacity: 1, y: 0 });
    expect(resolved.transition).toMatchObject({ duration: 0.2, ease: [0.2, 0, 0, 1] });
    expect(resolved.transition).not.toHaveProperty("repeat");
  });

  it("loops forever only for the looping entries", () => {
    expect(resolveMotionVariant("mark-breath", false).transition).toMatchObject({
      duration: 2.4,
      repeat: Number.POSITIVE_INFINITY,
    });
    expect(resolveMotionVariant("caret-blink", false).transition).toMatchObject({
      times: [0, 0.49, 0.5, 1],
      repeat: Number.POSITIVE_INFINITY,
    });
  });

  it("collapses every entry to an instant opacity target when reduced (R19.3)", () => {
    for (const name of MOTION_VARIANT_NAMES) {
      const resolved = resolveMotionVariant(name, true);
      expect(resolved.initial).toEqual({ opacity: 1 });
      expect(resolved.animate).toEqual({ opacity: 1 });
      expect(resolved.transition).toBeUndefined();
      // No movement survives, and nothing repeats.
      expect(animatedPropertiesOf(resolved.animate)).toEqual(["opacity"]);
    }
  });

  it("keeps an exit target present under reduced motion when the entry has one", () => {
    // AnimatePresence waits on `exit`; dropping the key would leave the dock
    // mounted rather than removing it instantly.
    expect(resolveMotionVariant("dock-entrance", true).exit).toEqual({ opacity: 1 });
    expect(resolveMotionVariant("row-entrance", true).exit).toBeUndefined();
  });
});

describe("concurrency budget (R19.5)", () => {
  it("tracks active elements and the high-water mark", () => {
    const budget = createMotionBudget();
    budget.start();
    budget.start();
    budget.start();
    budget.complete();
    expect(budget.active).toBe(2);
    expect(budget.peak).toBe(3);
    expect(budget.limit).toBe(MOTION_CONCURRENCY_LIMIT);
  });

  it("stays silent at the limit and warns once past it", () => {
    const onExceeded = vi.fn();
    const budget = createMotionBudget({ onExceeded });
    for (let i = 0; i < MOTION_CONCURRENCY_LIMIT; i += 1) budget.start();
    expect(onExceeded).not.toHaveBeenCalled();

    budget.start();
    budget.start();
    // One breach, one warning — not one per element.
    expect(onExceeded).toHaveBeenCalledTimes(1);
    expect(onExceeded).toHaveBeenCalledWith(MOTION_CONCURRENCY_LIMIT + 1, MOTION_CONCURRENCY_LIMIT);
  });

  it("warns again after the burst clears", () => {
    const onExceeded = vi.fn();
    const budget = createMotionBudget({ limit: 2, onExceeded });
    budget.start();
    budget.start();
    budget.start();
    expect(onExceeded).toHaveBeenCalledTimes(1);
    budget.complete();
    budget.start();
    expect(onExceeded).toHaveBeenCalledTimes(2);
  });

  it("never goes negative and resets", () => {
    const budget = createMotionBudget();
    budget.complete();
    budget.complete();
    expect(budget.active).toBe(0);
    budget.start();
    budget.reset();
    expect(budget.active).toBe(0);
    expect(budget.peak).toBe(0);
  });
});

describe("ChatMotionProvider", () => {
  function BudgetProbe() {
    const props = useMotionBudgetProps();
    useEffect(() => {
      props.onAnimationStart?.();
      props.onAnimationStart?.();
      props.onAnimationComplete?.();
    }, [props]);
    return <span>probe</span>;
  }

  it("wires animating children to the injected counter", () => {
    const budget = createMotionBudget();
    const { getByText } = render(
      <ChatMotionProvider budget={budget}>
        <BudgetProbe />
      </ChatMotionProvider>,
    );
    expect(getByText("probe")).toBeTruthy();
    expect(budget.peak).toBe(2);
    expect(budget.active).toBe(1);
  });

  it("hands out no-op props when counting is off", () => {
    const { getByText } = render(
      <ChatMotionProvider budget={null}>
        <BudgetProbe />
      </ChatMotionProvider>,
    );
    // Nothing to assert on a counter that does not exist: the point is that a
    // component spreading the props renders identically without a provider.
    expect(getByText("probe")).toBeTruthy();
  });
});
