/**
 * The usage row — zoc-agent-chat-rebuild R13.10, R27.1, task 16.3.
 *
 * One muted line at the foot of a settled Run: tokens in and out, the estimated cost, the model,
 * and the Run's Token_Rate. Activity tier and terminal — it says what the Run cost, which is
 * information rather than a decision, so it gets no card and no border.
 *
 * **"Replaces itself" is the streaming behaviour, and it is free here.** The runtime writes usage
 * to one reconciled part id, so a Run has exactly one usage part whose figures are revised; the
 * row therefore has no accumulate-or-replace logic to get wrong. Nothing in this component knows
 * it is the second render of the same part.
 *
 * **The figures come from `usage-figures.ts`.** Which cells exist at all is arithmetic — R13.10's
 * rule is that a `null` Token_Rate produces *no figure*, not a zero — so it lives in a pure
 * function the property can assert without mounting anything, and this file is spacing.
 *
 * **The accessible name is spoken, not punctuated.** A screen reader reading `12.4k in · 843 out
 * · 0.4¢` gets a middot and two fragments; `12.4k input tokens, 843 output tokens` is the same
 * information as a sentence. Both come from the same figure list, so they cannot disagree about
 * which cells the row has.
 */
import { cn } from "@/lib/utils";
import type { UsagePart } from "@zoc-studio/shared-types";
import { usageAccessibleName, usageFiguresOf } from "./usage-figures";

export interface UsageRowProps {
  usage: Pick<UsagePart, "inputTokens" | "outputTokens" | "estimatedCostCents" | "tokensPerSecond">;
  /** The model the Run ran on, from its lifecycle part or its message metadata. */
  model?: string;
  className?: string;
}

export function UsageRow({ usage, model, className }: UsageRowProps) {
  const figures = usageFiguresOf(usage, model);

  return (
    <div
      className={cn("flex flex-wrap items-baseline gap-x-2 gap-y-0.5", className)}
      style={{ paddingLeft: "var(--zoc-rail-inset)" }}
      data-zoc-row="usage"
      aria-label={usageAccessibleName(figures)}
    >
      {figures.map((figure, index) => (
        <span key={figure.key} className="inline-flex items-baseline gap-2">
          {index > 0 ? (
            <span aria-hidden style={{ color: "var(--zoc-text-faint)" }}>
              ·
            </span>
          ) : null}
          <span
            className="font-mono tabular-nums"
            data-zoc-usage-figure={figure.key}
            style={{
              color: "var(--zoc-text-muted)",
              fontSize: "var(--zoc-text-label)",
              lineHeight: "var(--zoc-leading-meta)",
            }}
          >
            {figure.value}
          </span>
        </span>
      ))}
    </div>
  );
}
