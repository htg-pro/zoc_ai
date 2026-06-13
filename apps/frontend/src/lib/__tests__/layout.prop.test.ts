// Feature: studio-ui-redesign, Property 34: Panel visibility toggles are involutions
// Feature: studio-ui-redesign, Property 35: Panel size constraints clamp within bounds
// Feature: studio-ui-redesign, Property 36: Layout (size + visibility) persistence round-trips
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DOCK_MIN_HEIGHT,
  PANEL_MAX_WIDTH,
  PANEL_MIN_WIDTH,
  type LayoutState,
  type PanelKey,
  clampDockHeight,
  clampPanelWidth,
  deserializeLayout,
  sanitizeLayout,
  serializeLayout,
  togglePanel,
} from "../layout";

const PANELS: PanelKey[] = ["explorer", "dock", "agent"];

const arbLayout: fc.Arbitrary<LayoutState> = fc.record({
  explorerWidth: fc.integer({ min: -100, max: 2000 }),
  agentWidth: fc.integer({ min: -100, max: 2000 }),
  dockHeight: fc.integer({ min: -100, max: 5000 }),
  explorerOpen: fc.boolean(),
  dockOpen: fc.boolean(),
  agentOpen: fc.boolean(),
});

const visOf = (s: LayoutState) => ({
  explorerOpen: s.explorerOpen,
  dockOpen: s.dockOpen,
  agentOpen: s.agentOpen,
});

describe("layout", () => {
  it("Property 34: toggling a panel inverts it; toggling twice restores it", () => {
    fc.assert(
      fc.property(arbLayout, fc.constantFrom(...PANELS), (state, panel) => {
        const once = togglePanel(state, panel);
        const twice = togglePanel(once, panel);

        const key = `${panel}Open` as const;
        // Inverted once.
        expect(once[key]).toBe(!state[key]);
        // Restored after two toggles.
        expect(twice[key]).toBe(state[key]);
        // Other panels untouched.
        for (const other of PANELS) {
          if (other === panel) continue;
          const ok = `${other}Open` as const;
          expect(once[ok]).toBe(state[ok]);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("Property 35: clamping respects panel and dock bounds", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -500, max: 3000 }),
        fc.integer({ min: 200, max: 4000 }),
        (size, windowHeight) => {
          const w = clampPanelWidth(size);
          expect(w).toBeGreaterThanOrEqual(PANEL_MIN_WIDTH);
          expect(w).toBeLessThanOrEqual(PANEL_MAX_WIDTH);

          const h = clampDockHeight(size, windowHeight);
          const upper = Math.max(DOCK_MIN_HEIGHT, Math.floor(windowHeight * 0.8));
          expect(h).toBeGreaterThanOrEqual(DOCK_MIN_HEIGHT);
          expect(h).toBeLessThanOrEqual(upper);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("Property 36: persistence round-trips sizes (after clamping) and visibility", () => {
    fc.assert(
      fc.property(
        arbLayout,
        fc.integer({ min: 400, max: 3000 }),
        (state, windowHeight) => {
          const sane = sanitizeLayout(state, windowHeight);
          const reloaded = deserializeLayout(serializeLayout(sane), windowHeight);

          expect(reloaded).toEqual(sane);
          // Visibility preserved exactly.
          expect(visOf(reloaded)).toEqual(visOf(state));
          // Idempotent under re-sanitize.
          expect(sanitizeLayout(sane, windowHeight)).toEqual(sane);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("falls back to defaults on missing/invalid persisted data", () => {
    expect(deserializeLayout(null, 1000).explorerOpen).toBe(true);
    expect(deserializeLayout("not json", 1000).agentWidth).toBeGreaterThanOrEqual(
      PANEL_MIN_WIDTH,
    );
  });
});
