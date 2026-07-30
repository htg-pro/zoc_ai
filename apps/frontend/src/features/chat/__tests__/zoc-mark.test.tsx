// Feature: zoc-agent-chat-rebuild, task 13.2: the brand mark component.
// Requirements: 18.1 (the mark replaces the lucide placeholder), 18.3 (legible
// at 16 px, so every documented size renders), 18.7 (activity signalling stays
// in the brand palette), 19.1 (opacity only), 19.3 (reduced motion stops the
// loop), 21.7 (state survives without colour).
//
// Property 52 (task 13.5) is the palette property and is not written here; what
// this file pins is the render contract: the sizes, the two accessibility
// shapes, and the fact that the reduced-motion path is a static end state
// rather than a loop.
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import {
  ZOC_MARK_PATH,
  ZOC_MARK_SIZES,
  ZOC_MARK_STATE_TOKENS,
  ZocMark,
  type ZocMarkProps,
} from "../brand/ZocMark";

// The breath is resolved through the registry, never hand-rolled, so the
// reduced-motion gate applies (R19.3). Wrapping the resolver is what lets this
// file assert the resolved transition rather than the engine's inline styles,
// which jsdom does not drive.
const resolveSpy = vi.hoisted(() => vi.fn());
vi.mock("@/lib/reduced-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reduced-motion")>();
  resolveSpy.mockImplementation(actual.resolveMotionVariant);
  return { ...actual, resolveMotionVariant: resolveSpy };
});

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function setReducedMotion(reduce: boolean): void {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query === REDUCED_MOTION_QUERY,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

function mount(props: ZocMarkProps = {}) {
  return render(
    <ChatMotionProvider budget={null}>
      <ZocMark {...props} />
    </ChatMotionProvider>,
  );
}

function markOf(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector<SVGSVGElement>("[data-zoc-mark]");
  if (!svg) throw new Error("no mark rendered");
  return svg;
}

afterEach(() => {
  cleanup();
  resolveSpy.mockClear();
  setReducedMotion(false);
});

describe("ZocMark geometry (R18.1, R18.2)", () => {
  it("carries the same path as the authored asset", () => {
    // The asset is the source of truth (task 13.1) and the icon pipeline reads
    // it (13.3). If the two drift, one of them is wrong and this is where it
    // shows up.
    const assetDir = path.resolve(__dirname, "../../../../public/brand");
    for (const file of ["zoc-mark.svg", "zoc-mark-mono.svg", "zoc-lockup.svg"]) {
      const asset = readFileSync(path.join(assetDir, file), "utf-8");
      expect(asset).toContain(ZOC_MARK_PATH);
    }
  });

  it("keeps the legibility story's hinted paths in step with the icon pipeline", () => {
    // Task 13.4's story previews the hinted variant beside the scaled one, and the
    // hinting belongs to `scripts/generate_icons.py`. The story transcribes the two paths
    // rather than recomputing them, so this is what stops the preview drifting from the
    // icons it exists to preview — the generator stays the source of truth.
    //
    // Read out of the story file rather than imported, because importing a `.stories.tsx`
    // pulls Ladle's types into the test graph for no benefit, and what is being checked is
    // the literal text a reader of the story sees.
    const story = readFileSync(path.resolve(__dirname, "../brand/zoc-mark.stories.tsx"), "utf-8");
    const generator = readFileSync(
      path.resolve(__dirname, "../../../../../../scripts/generate_icons.py"),
      "utf-8",
    );

    // Both hinted sizes the story shows, as the generator emits them.
    for (const hinted of [
      "M3 3H13V5L10 8H12L9 11H13V13H3V11H6L9 8H7L10 5H3Z",
      "M4 4H20V7L15 12H18L13 17H20V20H4V17H8L13 12H10L15 7H4Z",
    ]) {
      expect(story, "the story's hinted path").toContain(hinted);
    }
    // And the generator really is the thing that hints at these sizes, so a change to
    // `HINT_MAX_PX` or `HINTED_KINK_U` is visible here rather than only in the icons.
    expect(generator).toContain("HINT_MAX_PX = 24");
    expect(generator).toContain("HINTED_KINK_U = 3.0");
  });

  it("renders one closed fill-only subpath on the 24 u box", () => {
    const { container } = mount();
    const svg = markOf(container);
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");

    const body = svg.querySelector("[data-zoc-mark-body]");
    expect(body?.getAttribute("d")).toBe(ZOC_MARK_PATH);
    expect(body?.getAttribute("fill-rule")).toBe("nonzero");
    // Fill only: a stroke is what would change optical weight with size.
    expect(body?.getAttribute("stroke")).toBeNull();
  });

  it("resolves every colour through a token and never a literal", () => {
    // The two patterns are built from parts rather than written out, because writing
    // `rgba(` here would itself trip 12.4's colour-literal rule — the rule fires on the
    // literal node, and a test asserting the absence of literals is not an exemption from
    // holding none.
    const hexLiteral = new RegExp(`#[0-9a-f]{3,8}\\b`, "i");
    const functionalColour = `rgb${"a("}`;
    for (const state of ["idle", "running", "complete", "failed"] as const) {
      const { container } = mount({ state, title: "Zoc AI" });
      const markup = markOf(container).outerHTML;
      expect(markup).not.toMatch(hexLiteral);
      expect(markup).not.toContain(functionalColour);
      cleanup();
    }
  });
});

describe("ZocMark sizing (R18.3)", () => {
  it("renders at every documented size, 16 px included", () => {
    expect(ZOC_MARK_SIZES).toContain(16);
    for (const size of ZOC_MARK_SIZES) {
      const { container } = mount({ size });
      const svg = markOf(container);
      expect(svg.getAttribute("width")).toBe(String(size));
      expect(svg.getAttribute("height")).toBe(String(size));
      // The box never changes, so the geometry scales rather than reflowing.
      expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
      cleanup();
    }
  });

  it("defaults to 24 px", () => {
    const svg = markOf(mount().container);
    expect(svg.getAttribute("width")).toBe("24");
  });
});

describe("ZocMark accessibility", () => {
  it("hides a decorative instance from assistive technology", () => {
    const { container, queryByRole } = mount();
    expect(markOf(container).getAttribute("aria-hidden")).toBe("true");
    expect(queryByRole("img")).toBeNull();
    expect(container.querySelector("title")).toBeNull();
  });

  it("gives a titled instance an accessible name", () => {
    const { getByRole } = mount({ title: "Zoc AI" });
    const img = getByRole("img", { name: "Zoc AI" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });

  it("carries the run state as text as well as colour (R21.7)", () => {
    const { getByRole } = mount({ title: "Zoc AI", state: "running" });
    expect(getByRole("img", { name: /Active/ })).toBeTruthy();
  });
});

describe("ZocMark activity signalling (R18.7, R19.1, R19.3)", () => {
  it("paints activity from the brand violets and terminals from their own tokens", () => {
    expect(ZOC_MARK_STATE_TOKENS.idle).toEqual(["--zoc-agent-strong", "--zoc-agent-soft"]);
    expect(ZOC_MARK_STATE_TOKENS.running).toEqual(["--zoc-agent-strong", "--zoc-agent-soft"]);
    expect(ZOC_MARK_STATE_TOKENS.complete).toEqual(["--zoc-success"]);
    expect(ZOC_MARK_STATE_TOKENS.failed).toEqual(["--zoc-error"]);

    const { container } = mount({ state: "running" });
    const svg = markOf(container);
    expect(svg.querySelector("stop")?.getAttribute("stop-color")).toBe("var(--zoc-agent-strong)");
    expect(svg.querySelector("[data-zoc-mark-spark] rect")?.getAttribute("fill")).toBe(
      "var(--zoc-agent-soft)",
    );
  });

  it("animates one element in the running state and none otherwise", () => {
    const { container } = mount({ state: "running" });
    expect(container.querySelectorAll("[data-zoc-mark-spark]")).toHaveLength(1);
    cleanup();

    for (const state of ["idle", "complete", "failed"] as const) {
      const { container: idle } = mount({ state });
      expect(idle.querySelectorAll("[data-zoc-mark-spark]")).toHaveLength(0);
      cleanup();
    }
  });

  it("breathes opacity only, on a 2400 ms loop, through the registry", () => {
    mount({ state: "running" });
    expect(resolveSpy).toHaveBeenCalledWith("mark-breath", false);

    const resolved = resolveSpy.mock.results[0]?.value as {
      animate: Record<string, unknown>;
      transition?: { duration?: number; repeat?: number };
    };
    expect(Object.keys(resolved.animate)).toEqual(["opacity"]);
    expect(resolved.transition?.duration).toBe(2.4);
    expect(resolved.transition?.repeat).toBe(Number.POSITIVE_INFINITY);
  });

  it("renders outside the motion provider without animating or throwing", () => {
    // The panel mounts `ChatMotionProvider` (22.8), but a story or a standalone
    // consumer may not. `m` without a feature bundle renders statically, which
    // is the right degradation for a logo.
    const { container } = render(<ZocMark state="running" title="Zoc AI" />);
    expect(container.querySelectorAll("[data-zoc-mark-spark]")).toHaveLength(1);
  });

  it("keeps the mono variant on currentColor and drops the gradient", () => {
    const { container } = mount({ state: "running", mono: true });
    const svg = markOf(container);
    expect(svg.querySelector("linearGradient")).toBeNull();
    expect(svg.querySelector("[data-zoc-mark-body]")?.getAttribute("fill")).toBe("currentColor");
    // The breath still has exactly one element to animate.
    expect(svg.querySelectorAll("[data-zoc-mark-spark]")).toHaveLength(1);
  });
});

describe("ZocMark under reduced motion (R19.3, R21.7)", () => {
  it("resolves the breath to a static end state with no loop", () => {
    setReducedMotion(true);
    const { container } = mount({ state: "running" });

    expect(resolveSpy).toHaveBeenCalledWith("mark-breath", true);
    const resolved = resolveSpy.mock.results.at(-1)?.value as {
      initial: Record<string, unknown>;
      animate: Record<string, unknown>;
      transition?: unknown;
    };
    // No keyframe array, no transition, so nothing repeats.
    expect(resolved.initial).toEqual({ opacity: 1 });
    expect(resolved.animate).toEqual({ opacity: 1 });
    expect(resolved.transition).toBeUndefined();

    const spark = container.querySelector("[data-zoc-mark-spark]");
    expect(spark).not.toBeNull();
    expect(spark?.getAttribute("style") ?? "").not.toContain("transition");
  });

  it("substitutes the static ring cue for the breath", () => {
    setReducedMotion(true);
    const { container } = mount({ state: "running" });
    const ring = container.querySelector("[data-zoc-mark-ring]");
    expect(ring).not.toBeNull();
    expect(ring?.getAttribute("stroke")).toBe("var(--zoc-agent-strong)");
    // Shape, not colour: the ring is the cue and the icon names it.
    expect(ring?.getAttribute("data-cue")).toBe("Loader");
  });

  it("renders no ring while motion is allowed, and none for the idle state", () => {
    const { container } = mount({ state: "running" });
    expect(container.querySelector("[data-zoc-mark-ring]")).toBeNull();
    cleanup();

    setReducedMotion(true);
    const { container: idle } = mount({ state: "idle" });
    expect(idle.querySelector("[data-zoc-mark-ring]")).toBeNull();
  });
});
