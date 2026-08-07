/**
 * The mark legibility story — zoc-agent-chat-rebuild task 13.4 (R17.5, R18.3).
 *
 * Feature: zoc-agent-chat-rebuild, task 13.4 (R17.5, R18.3).
 *
 * R18.3's acceptance test is a *look*: at 16 × 16, 1× device pixel ratio, in both
 * themes, both counters must remain visibly open and the kink must remain visibly
 * a break. design.md:3030 makes that a Ladle story precisely so it is a
 * look-once check rather than a guess, and this is that story.
 *
 * Three things it shows that a plain size row would not, each because the gate
 * turns on it:
 *
 *   - **Both backgrounds, side by side.** The mark is drawn on `--zoc-bg` and on
 *     the light `--background`, because a violet-on-near-black form and the same
 *     form on white lose detail differently: the dark case loses the counters to
 *     bloom, the light case loses the kink to the surrounding value. Checking one
 *     and inferring the other is how a mark ships legible in exactly one theme.
 *   - **The hinted variant beside the scaled one at 16 and 24 px.** The authored
 *     2.5 u kink lands on a half-pixel at 16 px — `12.75 u × 16/24 = 8.5 px` — and
 *     the break blurs, which is the whole reason `generate_icons.py` substitutes a
 *     3.0 u kink with terminals snapped to whole pixels at and below 24 px. That
 *     substitution is invisible in the app (the component always draws the
 *     authored geometry) and visible in every icon, so the story is the one place
 *     the two can be compared.
 *   - **A magnified 16 px pair.** At true 16 px the thing being judged is roughly
 *     two device pixels across; the magnified copies render the same geometry at
 *     8× so a reviewer can see *which* pixel row the counter closed on. They are
 *     not a substitute for the true-size row — they sit beside it.
 *
 * There is no story for the four run states here: `ZOC_MARK_STATE_TOKENS` and the
 * breath are 13.2's, and Property 52 (13.5) asserts the palette. This story is
 * about geometry at size, which is the one thing a test cannot check.
 */
import type { Story } from "@ladle/react";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import { ZOC_MARK_SIZES, ZocMark, type ZocMarkSize } from "./ZocMark";

export default { title: "Brand" };

/**
 * The hinted geometry `scripts/generate_icons.py` emits at and below 24 px, in
 * the script's own pixel space.
 *
 * Transcribed from the generator's output rather than recomputed, and asserted
 * against it by `zoc-mark.test.tsx` — the script stays the source of truth, and a
 * story that derived the hinting independently would eventually disagree with the
 * icons it exists to preview.
 */
const HINTED: Readonly<Record<16 | 24, { viewBox: string; path: string }>> = {
  16: { viewBox: "0 0 16 16", path: "M3 3H13V5L10 8H12L9 11H13V13H3V11H6L9 8H7L10 5H3Z" },
  24: { viewBox: "0 0 24 24", path: "M4 4H20V7L15 12H18L13 17H20V20H4V17H8L13 12H10L15 7H4Z" },
};

/** The two surfaces the gate is judged against, named as the tokens name them. */
const SURFACES = [
  { label: "--zoc-bg (dark)", theme: "dark" as const, background: "var(--zoc-bg)" },
  { label: "--background (light)", theme: "light" as const, background: "hsl(var(--background))" },
];

/**
 * One surface panel.
 *
 * The `dark` class is set on the panel rather than on `<html>`, so both themes are
 * on screen at once. That is the whole point — the gate is a comparison, and a
 * Ladle theme toggle would make it a memory test.
 */
function Surface({
  label,
  theme,
  background,
  children,
}: {
  label: string;
  theme: "dark" | "light";
  background: string;
  children: React.ReactNode;
}) {
  return (
    <div className={theme === "dark" ? "dark" : undefined}>
      <div
        className="rounded-[var(--zoc-radius-card)] border border-[var(--zoc-border)] p-4"
        style={{ background }}
      >
        <div
          className="mb-3 font-mono uppercase"
          style={{
            color: "var(--zoc-text-muted)",
            fontSize: "var(--zoc-text-label)",
            letterSpacing: "var(--zoc-tracking-label)",
          }}
        >
          {label}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A labelled column, so a reviewer knows which size they are looking at. */
function Cell({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="flex items-center justify-center"
        style={{ color: "var(--zoc-agent-strong)", minHeight: 64 }}
      >
        {children}
      </div>
      <div
        className="font-mono"
        style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
      >
        {caption}
      </div>
    </div>
  );
}

/**
 * The hinted outline at its emitted size, optionally magnified.
 *
 * `shapeRendering="crispEdges"` on the magnified copy, because the point of
 * magnifying is to see where the rasteriser put each edge — antialiasing the
 * enlargement would hide exactly the half-pixel the hinting exists to avoid.
 */
function Hinted({ size, scale = 1 }: { size: 16 | 24; scale?: number }) {
  const spec = HINTED[size];
  return (
    <svg
      viewBox={spec.viewBox}
      width={size * scale}
      height={size * scale}
      aria-hidden
      focusable={false}
      {...(scale > 1 ? { shapeRendering: "crispEdges" as const } : {})}
    >
      <path d={spec.path} fill="currentColor" fillRule="nonzero" />
    </svg>
  );
}

/**
 * The story R18.3's gate is checked against: every documented size, both surfaces.
 *
 * `40` is in `ZOC_MARK_SIZES` for the empty state (22.8) and is drawn here too, so
 * the row is the union rather than the design's six — a size that ships and is
 * never reviewed is the one that will be wrong.
 */
export const MarkLegibility: Story = () => (
  <ChatMotionProvider budget={null}>
    <div className="flex flex-col gap-4">
      <p style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-body)" }}>
        R18.3 gate: at 16 px both counters must read as open and the kink as a break. Judge the{" "}
        <strong>16</strong> column at 1× — the magnified row below is for locating a failure, not
        for passing the gate.
      </p>
      {SURFACES.map((surface) => (
        <Surface key={surface.label} {...surface}>
          <div className="flex flex-wrap items-end gap-6">
            {ZOC_MARK_SIZES.map((size: ZocMarkSize) => (
              <Cell key={size} caption={`${String(size)} px`}>
                <ZocMark size={size} title="Zoc AI" />
              </Cell>
            ))}
          </div>
        </Surface>
      ))}
    </div>
  </ChatMotionProvider>
);

/**
 * The authored geometry against the hinted one, at the two sizes where they differ.
 *
 * The substitution is invisible in the app and present in every icon, so this is the
 * only place the two can be compared. At 16 px the authored kink sits at 8.5 device
 * pixels and the hinted one at a whole pixel; magnified 8×, that is the difference
 * between a soft step and a clean break.
 */
export const HintedVersusScaled: Story = () => (
  <ChatMotionProvider budget={null}>
    <div className="flex flex-col gap-4">
      <p style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-body)" }}>
        Left of each pair: the authored 2.5 u kink, scaled. Right: the 3.0 u hinted variant{" "}
        <code>generate_icons.py</code> emits at and below 24 px. The app always draws the left one;
        every desktop icon is the right one.
      </p>
      {SURFACES.map((surface) => (
        <Surface key={surface.label} {...surface}>
          <div className="flex flex-wrap items-end gap-8">
            {([16, 24] as const).map((size) => (
              <div key={size} className="flex items-end gap-6">
                <Cell caption={`${String(size)} scaled`}>
                  <ZocMark size={size} title="Zoc AI" />
                </Cell>
                <Cell caption={`${String(size)} hinted`}>
                  <Hinted size={size} />
                </Cell>
                <Cell caption={`${String(size)} scaled ×8`}>
                  <ZocMark size={size} title="Zoc AI" className="origin-center scale-[8]" />
                </Cell>
                <Cell caption={`${String(size)} hinted ×8`}>
                  <Hinted size={size} scale={8} />
                </Cell>
              </div>
            ))}
          </div>
        </Surface>
      ))}
    </div>
  </ChatMotionProvider>
);
