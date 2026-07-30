/**
 * The Chat_Surface's token pairs and their contrast roles — R17.1, R17.2, R17.6.
 *
 * Not a third token system, and not a copy of one. `globals.css` holds the values; this
 * module holds the **pairings** — which foreground is drawn on which background, and in what
 * role — because that is the fact R17.6 constrains and CSS cannot state. A contrast
 * threshold applies to a pair, and a stylesheet only ever declares one side of one.
 *
 * **Why the values are mirrored here at all.** The property test needs numbers, and a
 * jsdom environment resolves a custom property to the empty string unless the whole
 * cascade is loaded — so a test that read `getComputedStyle` would assert 4.5:1 against
 * `""` and pass for every pair forever. Mirroring is the lesser evil, and it is made safe
 * by {@link TOKEN_VALUES} being checked against `globals.css` by its own test: a value
 * edited in one place and not the other fails, which is the failure mode mirroring
 * ordinarily invites.
 *
 * **Roles, and why there are two thresholds rather than one.** R17.6 asks for 4.5:1 on body
 * text and 3:1 on interactive boundaries and iconography, which is WCAG's own split — text
 * has to be read, a border only has to be found. Declaring the role per pair is what lets
 * `--zoc-agent` be legitimate as a 3:1 icon colour and illegitimate as body text, which is
 * exactly the distinction design.md:3074 draws for it.
 */

/** Every token this module pairs, with its literal from `globals.css`. */
export const TOKEN_VALUES = {
  // ── Surfaces ────────────────────────────────────────────────────────
  "--zoc-bg": "#0b0e14",
  "--zoc-panel": "#131318",
  "--zoc-row-bg": "#15151a",
  "--zoc-elev-1": "#131318",
  "--zoc-elev-2": "#1a1a21",

  // ── Text ────────────────────────────────────────────────────────────
  "--zoc-text": "#fafafa",
  "--zoc-text-secondary": "#c8c8ce",
  "--zoc-text-muted": "#a1a1aa",
  "--zoc-text-faint": "#71717a",

  // ── Brand and state ─────────────────────────────────────────────────
  "--zoc-agent": "#8b7cf6",
  "--zoc-agent-strong": "#9b6af1",
  "--zoc-agent-soft": "#b79bf9",
  "--zoc-ember": "#fb923c",
  "--zoc-info": "#60a5fa",
  "--zoc-success": "#4ade80",
  "--zoc-error": "#f87171",

  // ── Hairlines ───────────────────────────────────────────────────────
  "--zoc-border": "#26262b",
  "--zoc-row-border": "#26262b",
} as const;

export type TokenName = keyof typeof TOKEN_VALUES;

/**
 * What a foreground carries, which is what picks its threshold.
 *
 * `decorative` is neither of R17.6's two classes and is exempt — but only where the token
 * genuinely carries no information. Every entry using it names why, because "decorative"
 * is the escape hatch that would let any pair pass.
 */
export type ContrastRole = "body-text" | "boundary" | "decorative";

/** R17.6's two thresholds. */
export const CONTRAST_THRESHOLDS: Readonly<Record<Exclude<ContrastRole, "decorative">, number>> = {
  "body-text": 4.5,
  boundary: 3,
};

export interface TokenPair {
  readonly foreground: TokenName;
  readonly background: TokenName;
  readonly role: ContrastRole;
  /** What renders this pair. Names a real surface, so a stale pair is findable. */
  readonly usage: string;
}

/**
 * Every pair the Chat_Surface renders, dark theme.
 *
 * One theme rather than two, because the app ships `<html class="dark">` and `globals.css`
 * declares only a dark `.dark` counterpart — there is no light palette to pair against yet.
 * Property 50 asks for both themes; asserting a second set against values that do not exist
 * would be asserting against the dark ones twice, which is a test that reports coverage it
 * does not have. {@link THEMES} is the seam a light pass fills, and the property iterates it.
 */
const DARK_PAIRS: readonly TokenPair[] = [
  // ── Body text ───────────────────────────────────────────────────────
  {
    foreground: "--zoc-text",
    background: "--zoc-bg",
    role: "body-text",
    usage: "assistant answer text, user message text",
  },
  {
    foreground: "--zoc-text",
    background: "--zoc-panel",
    role: "body-text",
    usage: "text inside a decision card",
  },
  {
    foreground: "--zoc-text",
    background: "--zoc-elev-2",
    role: "body-text",
    usage: "permission dock and popover text",
  },
  {
    foreground: "--zoc-text-secondary",
    background: "--zoc-bg",
    role: "body-text",
    usage: "tool labels, file paths",
  },
  {
    foreground: "--zoc-text-secondary",
    background: "--zoc-row-bg",
    role: "body-text",
    usage: "activity-row labels",
  },
  {
    foreground: "--zoc-text-muted",
    background: "--zoc-bg",
    role: "body-text",
    usage: "timestamps, usage figures, badge text",
  },
  {
    foreground: "--zoc-text-muted",
    background: "--zoc-row-bg",
    role: "body-text",
    usage: "nested-row metadata",
  },
  // `--zoc-text-faint` is deliberately absent from the body-text set. It measures below
  // 4.5:1 on every surface here, which is why design.md:3074 restricts it to non-text uses
  // and to ≥ 11 px semibold section labels — and why any faint text carrying meaning is
  // promoted to `--zoc-text-muted` instead. Its one legitimate pair is below.
  {
    foreground: "--zoc-text-faint",
    background: "--zoc-bg",
    role: "decorative",
    usage: "section label glyphs and empty-state icons — never informational text",
  },

  // ── Boundaries and iconography ──────────────────────────────────────
  {
    foreground: "--zoc-agent",
    background: "--zoc-bg",
    role: "boundary",
    usage: "brand mark, running-state indicator, agent-authored accent",
  },
  {
    foreground: "--zoc-agent-strong",
    background: "--zoc-bg",
    role: "boundary",
    usage: "focus ring, mark gradient stop",
  },
  {
    foreground: "--zoc-agent-soft",
    background: "--zoc-bg",
    role: "boundary",
    usage: "mark spark highlight, hover tint",
  },
  {
    foreground: "--zoc-ember",
    background: "--zoc-elev-2",
    role: "boundary",
    usage: "permission dock accent — blocked on you, and nothing else (R17.2)",
  },
  {
    foreground: "--zoc-info",
    background: "--zoc-bg",
    role: "boundary",
    usage: "tool-call and read iconography, Ask mode",
  },
  {
    foreground: "--zoc-success",
    background: "--zoc-bg",
    role: "boundary",
    usage: "completed, applied, pass",
  },
  {
    foreground: "--zoc-error",
    background: "--zoc-bg",
    role: "boundary",
    usage: "error state and validation failure",
  },
  {
    foreground: "--zoc-error",
    background: "--zoc-panel",
    role: "boundary",
    usage: "error strip on a decision card",
  },
  // Hairlines are the pairs a 3:1 rule is hardest on, and they are recorded rather than
  // omitted: a border nobody can see is a card with no edge.
  {
    foreground: "--zoc-border",
    background: "--zoc-bg",
    role: "decorative",
    usage: "panel hairline — a separator, not an interactive boundary",
  },
  {
    foreground: "--zoc-row-border",
    background: "--zoc-row-bg",
    role: "decorative",
    usage: "nested-row hairline — a separator, not an interactive boundary",
  },
];

export const THEMES = { dark: DARK_PAIRS } as const;

export type ThemeName = keyof typeof THEMES;

export const TOKEN_PAIRS: readonly TokenPair[] = Object.values(THEMES).flat();

// ── Contrast arithmetic (WCAG 2.1 relative luminance) ─────────────────

/** Parse `#rrggbb` into 0–255 channels. Throws on anything else, deliberately. */
export function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match?.[1] === undefined) {
    // A token whose value cannot be parsed must not silently contribute a luminance of 0,
    // which would make every pair against it pass or fail for the wrong reason.
    throw new Error(`Not a six-digit hex colour: ${hex}`);
  }
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** WCAG relative luminance: sRGB channels linearised, then weighted. */
export function relativeLuminance(hex: string): number {
  const linear = parseHex(hex).map((channel) => {
    const ratio = channel / 255;
    return ratio <= 0.039_28 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG contrast ratio, always ≥ 1 and order-independent. */
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/** The measured ratio for one declared pair. */
export function ratioOf(pair: TokenPair): number {
  return contrastRatio(TOKEN_VALUES[pair.foreground], TOKEN_VALUES[pair.background]);
}
