/**
 * The usage line's figures — zoc-agent-chat-rebuild R13.10, R27.1, task 16.3.
 *
 * A `UsagePart` reduced to the ordered, formatted cells one muted line shows. Pure, because every
 * decision here is arithmetic that a rendering test cannot reach cheaply: which figures appear at
 * all, how a token count abbreviates, and what happens to a rate the runtime could not measure.
 *
 * ## Absence is the interesting case, and it is R13.10's
 *
 * `tokensPerSecond` is `null` when a Run produced no output tokens, and the requirement is that
 * the row then shows **no figure** rather than a zero. Zero tokens per second is a legible claim
 * about a model and it would be a false one — so an absent figure is dropped from the cell list
 * entirely rather than rendered as `0`, `—`, or `n/a`. The same rule covers a cost the runtime
 * could not estimate.
 *
 * ## What is not on the line
 *
 * `reasoningTokens` and `cachedInputTokens` ride on the part and are deliberately absent from the
 * cells. The design words this row as a *single* muted line carrying tokens in and out, cost,
 * model, and Token_Rate; five figures already fill it at the meta type size, and the two extra
 * ones answer a question — where did the cost come from — that R27's cost surface is the place
 * for. They are on the part, so adding them later is a change to this function alone.
 */

import type { UsagePart } from "@zoc-studio/shared-types";

/**
 * One cell of the usage line.
 *
 * Two strings rather than one, because the line is punctuated and speech is not: `12.4k in` is
 * the right cell and the wrong sentence, and `12.4k input tokens` is the reverse. Deriving the
 * second from the first is what produces the "12.4k in input tokens" a screen reader would
 * otherwise read out.
 */
export interface UsageFigure {
  readonly key: "input" | "output" | "cost" | "model" | "rate";
  /** Drawn in the line. */
  readonly value: string;
  /** Read aloud, as part of the row's accessible name. */
  readonly spoken: string;
}

/**
 * A token count, abbreviated past a thousand.
 *
 * Exact below 1 000 because those counts are read as counts; abbreviated above, because the line
 * is scanned rather than audited and `12.4k` is narrower than `12 431` at no cost in meaning. The
 * `.0` is dropped so `12.0k` never appears — a trailing zero reads as precision the figure does
 * not have.
 */
export function formatTokens(count: number): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.round(count) : 0;
  if (safe < 1000) return String(safe);
  if (safe < 1_000_000) return `${trimZero(safe / 1000)}k`;
  return `${trimZero(safe / 1_000_000)}M`;
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * An estimated cost, or `null` when there is none to state (R13.10's rule, applied to cost).
 *
 * Cents below a dollar and dollars above, rather than `$0.0042` throughout: a Run costing four
 * tenths of a cent is the common case, and four leading zeroes is a figure a reader has to count
 * digits to understand. The currency is USD, which is what every provider's published pricing —
 * and therefore the runtime's estimate — is denominated in.
 */
export function formatCostCents(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return null;
  if (cents < 0) return null;
  if (cents >= 100) return `$${(cents / 100).toFixed(2)}`;
  return `${trimZero(cents)}¢`;
}

/**
 * Token_Rate, or `null` when the runtime reported none (R13.10).
 *
 * One decimal below a hundred and a whole number above. The threshold is where the decimal stops
 * carrying anything: a user comparing 24.7 tok/s against 31.2 is reading a real difference, and
 * 132 against 132.4 is reading noise. Below 100 is also where nearly every real rate lands, so a
 * higher threshold would leave the decimal branch effectively dead.
 */
export function formatTokenRate(tokensPerSecond: number | null | undefined): string | null {
  if (tokensPerSecond === null || tokensPerSecond === undefined) return null;
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return null;
  const figure =
    tokensPerSecond < 100 ? tokensPerSecond.toFixed(1) : String(Math.round(tokensPerSecond));
  return `${figure} tok/s`;
}

/**
 * The ordered cells for one Run's usage line.
 *
 * `model` comes from the caller rather than the part: `UsagePart` carries the accounting and the
 * context census, and the model reference lives on the Run's lifecycle part and its message
 * metadata. Passing it in keeps one part from having to mirror another's field.
 */
export function usageFiguresOf(
  usage: Pick<UsagePart, "inputTokens" | "outputTokens" | "estimatedCostCents" | "tokensPerSecond">,
  model?: string,
): readonly UsageFigure[] {
  const input = formatTokens(usage.inputTokens);
  const output = formatTokens(usage.outputTokens);
  const figures: UsageFigure[] = [
    { key: "input", value: `${input} in`, spoken: `${input} input tokens` },
    { key: "output", value: `${output} out`, spoken: `${output} output tokens` },
  ];

  const cost = formatCostCents(usage.estimatedCostCents);
  if (cost !== null) figures.push({ key: "cost", value: cost, spoken: `estimated cost ${cost}` });

  if (model !== undefined && model.length > 0) {
    figures.push({ key: "model", value: model, spoken: `model ${model}` });
  }

  const rate = formatTokenRate(usage.tokensPerSecond);
  if (rate !== null) {
    figures.push({
      key: "rate",
      value: rate,
      spoken: `${rate.replace(" tok/s", "")} tokens per second`,
    });
  }

  return figures;
}

/** The line's accessible name: every cell it shows, spoken rather than punctuated. */
export function usageAccessibleName(figures: readonly UsageFigure[]): string {
  return `Run usage: ${figures.map((figure) => figure.spoken).join(", ")}`;
}
