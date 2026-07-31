/**
 * Property 52: Activity signalling uses the brand palette. Validates R18.7.
 *
 * R18.7 asks that where the interface indicates agent *activity*, it uses the mark's
 * violet and spark palette — so brand and activity signalling stay consistent, and so
 * "violet means Zoc AI is working" is a fact a user can rely on rather than a habit.
 *
 * The property therefore has two directions, and only asserting both makes it mean
 * anything:
 *
 *   - **Every activity state paints from the brand set.** `idle` and `running` are the
 *     two activity states; both resolve to `--zoc-agent-strong`/`--zoc-agent-soft`.
 *   - **No non-activity state does.** `complete` and `failed` must *leave* the violets,
 *     because a terminal state painted in the brand colour is what makes the first
 *     direction useless: if everything is violet, violet signals nothing. A registry
 *     that returned the brand tokens for all four states would satisfy a one-directional
 *     reading of the requirement and defeat its purpose.
 *
 * Asserted against the rendered DOM as well as against the token table, because the
 * table is a claim and the render is the fact. `ZOC_MARK_STATE_TOKENS` exists so R18.7
 * is a property of a data structure, but a component that ignored it would still pass a
 * test that only read the table.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";

import { ChatMotionProvider } from "@/lib/reduced-motion-provider";
import {
  ZOC_MARK_SIZES,
  ZOC_MARK_STATE_TOKENS,
  ZocMark,
  type ZocMarkSize,
  type ZocMarkState,
} from "@/features/chat/brand/ZocMark";
import { TOKEN_VALUES } from "@/features/chat/tokens";

const RUNS = { numRuns: 100 } as const;

/**
 * The brand set, as design.md:3062's table defines it: the three violets and nothing
 * else. `--zoc-info`, `--zoc-success`, and `--zoc-error` are state colours rather than
 * brand ones, which is exactly the distinction the property turns on.
 */
const BRAND_TOKENS: readonly string[] = ["--zoc-agent", "--zoc-agent-strong", "--zoc-agent-soft"];

/** The two states that indicate the agent is working, or ready to. */
const ACTIVITY_STATES: readonly ZocMarkState[] = ["idle", "running"];

/** The two that indicate it has stopped. */
const TERMINAL_STATES: readonly ZocMarkState[] = ["complete", "failed"];

const ALL_STATES: readonly ZocMarkState[] = [...ACTIVITY_STATES, ...TERMINAL_STATES];

const state: fc.Arbitrary<ZocMarkState> = fc.constantFrom(...ALL_STATES);
const size: fc.Arbitrary<ZocMarkSize> = fc.constantFrom(...ZOC_MARK_SIZES);

afterEach(cleanup);

/** Every `var(--token)` the rendered mark paints from. */
function paintedTokens(props: {
  state: ZocMarkState;
  size?: ZocMarkSize;
  mono?: boolean;
}): string[] {
  const { container } = render(
    <ChatMotionProvider budget={null}>
      <ZocMark {...props} title="Zoc AI" />
    </ChatMotionProvider>,
  );

  const found: string[] = [];
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      for (const match of attribute.value.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
        const token = match[1];
        if (token !== undefined) found.push(token);
      }
    }
  }
  return found;
}

describe("Feature: zoc-agent-chat-rebuild, Property 52: activity signalling uses the brand palette", () => {
  it("paints every activity state from the brand set, at any size", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ACTIVITY_STATES), size, (activity, at) => {
        cleanup();
        const painted = paintedTokens({ state: activity, size: at });

        // Something is painted — otherwise the subset check below is trivially true.
        const brandPainted = painted.filter((token) => BRAND_TOKENS.includes(token));
        expect(brandPainted.length, `${activity} at ${String(at)}px`).toBeGreaterThan(0);

        // And nothing outside the brand set is painted for an activity state.
        for (const token of painted) {
          expect(BRAND_TOKENS, `${activity} painted ${token}`).toContain(token);
        }
      }),
      RUNS,
    );
  });

  it("leaves the brand set for every terminal state", () => {
    // The direction that makes the first one mean something. If `complete` and `failed`
    // were also violet, violet would signal nothing at all.
    fc.assert(
      fc.property(fc.constantFrom(...TERMINAL_STATES), size, (terminal, at) => {
        cleanup();
        const painted = paintedTokens({ state: terminal, size: at });

        expect(painted.length, `${terminal} at ${String(at)}px`).toBeGreaterThan(0);
        for (const token of painted) {
          expect(BRAND_TOKENS, `${terminal} painted the brand token ${token}`).not.toContain(token);
        }
      }),
      RUNS,
    );
  });

  it("agrees with the token table, which is what R18.7 is a property of", () => {
    // The table is the claim; the render is the fact. A component that ignored
    // `ZOC_MARK_STATE_TOKENS` would pass a test that only read the table, so both are
    // checked and against each other.
    fc.assert(
      fc.property(state, (which) => {
        cleanup();
        const declared = ZOC_MARK_STATE_TOKENS[which];
        const painted = new Set(paintedTokens({ state: which }));

        for (const token of declared) {
          expect(painted.has(token), `${which} declares ${token} but does not paint it`).toBe(true);
        }
      }),
      RUNS,
    );
  });

  it("declares brand tokens for exactly the activity states", () => {
    for (const activity of ACTIVITY_STATES) {
      for (const token of ZOC_MARK_STATE_TOKENS[activity]) {
        expect(BRAND_TOKENS, activity).toContain(token);
      }
    }
    for (const terminal of TERMINAL_STATES) {
      for (const token of ZOC_MARK_STATE_TOKENS[terminal]) {
        expect(BRAND_TOKENS, terminal).not.toContain(token);
      }
    }
  });

  it("gives idle and running the same palette, so the breath is the only difference", () => {
    // R18.7's consistency clause read strictly: activity is signalled by the mark's
    // palette, so `running` adds the spark's breath rather than a different hue. A
    // running state in its own colour would make three colours mean "working".
    expect(ZOC_MARK_STATE_TOKENS.running).toEqual(ZOC_MARK_STATE_TOKENS.idle);
  });

  it("paints only from tokens that exist", () => {
    // A `var(--typo)` resolves to nothing and renders an invisible mark; a rendered token
    // that is not in the mirrored set is also one the contrast property never measures.
    fc.assert(
      fc.property(state, fc.boolean(), (which, mono) => {
        cleanup();
        for (const token of paintedTokens({ state: which, mono })) {
          expect(Object.keys(TOKEN_VALUES), `${which}: ${token}`).toContain(token);
        }
      }),
      RUNS,
    );
  });

  it("inherits currentColor in the monochrome variant, painting no token at all", () => {
    // R18.2's single-colour variant. The consumer sets the colour once on the parent, so
    // the mark itself must not reach for a brand token — which would make the monochrome
    // variant silently violet.
    fc.assert(
      fc.property(state, (which) => {
        cleanup();
        expect(paintedTokens({ state: which, mono: true })).toEqual([]);
      }),
      RUNS,
    );
  });
});
