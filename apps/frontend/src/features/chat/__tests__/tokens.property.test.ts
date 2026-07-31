/**
 * Property 50: Every used token pair meets its contrast threshold. Validates R17.6.
 *
 * Exhaustive over the declared pairs rather than sampled — the set is a fixed table and
 * generating indices into it would rediscover the same rows more slowly. The generated axes
 * are the ones that are not enumerable: arbitrary hex colours for the arithmetic's own
 * invariants, which is what stops a broken `contrastRatio` from making every row pass.
 *
 * **The mirrored token values are checked against `globals.css`**, because mirroring is what
 * makes this test possible and also what would silently invalidate it. jsdom resolves a
 * custom property to `""` unless the whole cascade is loaded, so a test reading
 * `getComputedStyle` would compare 4.5:1 against an empty string and pass forever; mirroring
 * is the lesser evil, and the stylesheet check is what keeps it honest.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";

import {
  CONTRAST_THRESHOLDS,
  THEMES,
  TOKEN_PAIRS,
  TOKEN_VALUES,
  contrastRatio,
  parseHex,
  ratioOf,
  relativeLuminance,
  type TokenName,
} from "@/features/chat/tokens";

const RUNS = { numRuns: 100 } as const;

const hexColour = fc
  .tuple(fc.nat({ max: 255 }), fc.nat({ max: 255 }), fc.nat({ max: 255 }))
  .map(
    ([r, g, b]) => `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
  );

const GLOBALS_CSS = readFileSync(resolve(process.cwd(), "src/styles/globals.css"), "utf8");

/** Every `--zoc-*: value;` declaration in the stylesheet, last one winning. */
function declaredTokens(): Map<string, string> {
  const declared = new Map<string, string>();
  const pattern = /(--zoc-[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  for (const match of GLOBALS_CSS.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) declared.set(name, value.trim());
  }
  return declared;
}

describe("Feature: zoc-agent-chat-rebuild, Property 50: every used token pair meets its contrast threshold", () => {
  it("clears 4.5:1 for every body-text pair", () => {
    for (const pair of TOKEN_PAIRS.filter((entry) => entry.role === "body-text")) {
      const ratio = ratioOf(pair);
      expect(
        ratio,
        `${pair.foreground} on ${pair.background} (${pair.usage}) measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLDS["body-text"]);
    }
  });

  it("clears 3:1 for every interactive boundary and icon pair", () => {
    for (const pair of TOKEN_PAIRS.filter((entry) => entry.role === "boundary")) {
      const ratio = ratioOf(pair);
      expect(
        ratio,
        `${pair.foreground} on ${pair.background} (${pair.usage}) measured ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLDS.boundary);
    }
  });

  it("holds in every declared theme", () => {
    // One theme today. Asserted as a loop rather than against `dark` directly, so the light
    // pass adds values and this test starts covering them without an edit.
    for (const [theme, pairs] of Object.entries(THEMES)) {
      expect(pairs.length, theme).toBeGreaterThan(0);
      for (const pair of pairs) {
        if (pair.role === "decorative") continue;
        expect(
          ratioOf(pair),
          `${theme}: ${pair.foreground} on ${pair.background}`,
        ).toBeGreaterThanOrEqual(CONTRAST_THRESHOLDS[pair.role]);
      }
    }
  });

  it("keeps --zoc-text-faint out of every body-text pair", () => {
    // The specific restriction design.md:3074 states: it measures 4.00:1 on `--zoc-bg`, so
    // any faint text carrying meaning must be promoted to `--zoc-text-muted`. Asserted as an
    // absence, because that is how the rule can be broken — by adding a row, not by editing
    // one.
    const bodyText = TOKEN_PAIRS.filter((pair) => pair.role === "body-text");
    expect(bodyText.some((pair) => pair.foreground === "--zoc-text-faint")).toBe(false);
    // And the reason, pinned: if a future palette lifted it above the threshold this
    // assertion would fail and the restriction could be revisited deliberately.
    expect(
      ratioOf({
        foreground: "--zoc-text-faint",
        background: "--zoc-bg",
        role: "decorative",
        usage: "check",
      }),
    ).toBeLessThan(CONTRAST_THRESHOLDS["body-text"]);
  });

  it("names a usage for every pair, so a stale row is findable", () => {
    for (const pair of TOKEN_PAIRS) {
      expect(pair.usage.length, `${pair.foreground} on ${pair.background}`).toBeGreaterThan(8);
    }
  });
});

describe("the mirrored token values agree with globals.css", () => {
  it("declares every mirrored token, at the same value", () => {
    const declared = declaredTokens();
    for (const [name, value] of Object.entries(TOKEN_VALUES)) {
      const actual = declared.get(name);
      expect(actual, `${name} is not declared in globals.css`).toBeDefined();
      // Case-insensitive: the stylesheet writes `#8b7cf6`, the design writes `#8B7CF6`.
      expect(actual?.toLowerCase(), name).toBe(value.toLowerCase());
    }
  });

  it("mirrors every colour token the stylesheet declares, so a new one cannot be missed", () => {
    // The direction that catches an omission rather than a divergence. Non-colour tokens —
    // durations, easings, sizes, radii — are excluded by shape rather than by name, so
    // adding one does not require editing this test.
    const mirrored = new Set(Object.keys(TOKEN_VALUES));
    for (const [name, value] of declaredTokens()) {
      if (!/^#[0-9a-f]{6}$/i.test(value)) continue;
      expect(mirrored.has(name), `${name} is declared in globals.css but not paired here`).toBe(
        true,
      );
    }
  });
});

describe("the contrast arithmetic itself", () => {
  // Without these, a broken `contrastRatio` would make every pair above pass. Generated
  // rather than enumerated: the invariants are about all colours, not about the palette.
  it("is symmetric and never below 1", () => {
    fc.assert(
      fc.property(hexColour, hexColour, (a, b) => {
        const forward = contrastRatio(a, b);
        expect(contrastRatio(b, a)).toBeCloseTo(forward, 10);
        expect(forward).toBeGreaterThanOrEqual(1);
      }),
      RUNS,
    );
  });

  it("is exactly 1 for a colour against itself", () => {
    fc.assert(
      fc.property(hexColour, (colour) => {
        expect(contrastRatio(colour, colour)).toBeCloseTo(1, 10);
      }),
      RUNS,
    );
  });

  it("anchors on the two known extremes", () => {
    // Black on white is 21:1 by definition, and luminance runs 0 to 1.
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    expect(relativeLuminance("#000000")).toBeCloseTo(0, 10);
    expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 10);
  });

  it("never exceeds 21:1", () => {
    fc.assert(
      fc.property(hexColour, hexColour, (a, b) => {
        expect(contrastRatio(a, b)).toBeLessThanOrEqual(21);
      }),
      RUNS,
    );
  });

  it("refuses a value it cannot parse rather than treating it as black", () => {
    // The failure mode mirroring invites: a token edited to `var(--other)` or a three-digit
    // hex would otherwise contribute a luminance of 0 and make every pair against it pass.
    for (const bad of ["", "#fff", "rgb(0,0,0)", "var(--zoc-bg)", "#gggggg", "8b7cf6"]) {
      expect(() => parseHex(bad), bad).toThrow();
    }
  });

  it("agrees with the published ratio for the palette's tightest pair", () => {
    // `--zoc-agent-strong` on `--zoc-elev-2` is the narrowest boundary pair in the table, at
    // 4.72:1. Pinning one measured figure is what catches a linearisation that is subtly
    // wrong — the symmetry and range checks above would not.
    const ratio = contrastRatio(TOKEN_VALUES["--zoc-agent-strong"], TOKEN_VALUES["--zoc-elev-2"]);
    expect(ratio).toBeCloseTo(4.72, 1);
  });

  it("measures every mirrored token, so none is unparseable", () => {
    for (const name of Object.keys(TOKEN_VALUES) as TokenName[]) {
      expect(() => relativeLuminance(TOKEN_VALUES[name]), name).not.toThrow();
    }
  });
});
