/**
 * The Effort control — zoc-agent-chat-rebuild R32.1's neighbour, task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R32.1).
 *
 * `fast` / `balanced` / `thorough`, immediately right of Mode, labelled **Effort**, on a Radix `Popover`.
 * Extracted from the legacy panel's inline control into its own file for the reason Amendment 1 gives:
 * the composer now carries two mode axes, and a third inline control in the same row is what makes three
 * controls read as one undifferentiated strip.
 *
 * ## Why a popover rather than a third segmented control
 *
 * Segmented controls are for axes a user is choosing *between* — the two mode axes are, and they look
 * alike on purpose. Effort is a dial, it is discretionary, and it is the first thing to give up space
 * (its value text goes below 420 px, the container rule in `globals.css`). Giving it the same treatment
 * as Mode would say the three are peers, which is exactly the confusability the split exists to avoid.
 *
 * ## What it maps to
 *
 * Provider reasoning-effort where the provider has one, and a token budget where it does not. That
 * mapping is the runtime's — the control's job is to hold the user's choice, and the chat-local store is
 * where it lives because it is a per-turn preference scoped to one Session.
 */
import { Gauge } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { Effort } from "../store";

interface EffortItem {
  readonly effort: Effort;
  readonly label: string;
  readonly description: string;
}

const ITEMS: readonly EffortItem[] = [
  { effort: "fast", label: "fast", description: "Fewest steps. Best for small, clear tasks." },
  { effort: "balanced", label: "balanced", description: "The default. Reasons when it helps." },
  {
    effort: "thorough",
    label: "thorough",
    description: "Reasons more and checks its work. Slower and costs more.",
  },
];

export interface EffortControlProps {
  value: Effort;
  onChange: (effort: Effort) => void;
  className?: string;
}

export function EffortControl({ value, onChange, className }: EffortControlProps) {
  return (
    // Trapped for the same reason the model picker is (R21.6, task 23.1): a Radix Popover at its
    // default restores focus but does not trap it, so Tab escapes the option list into the page.
    <Popover modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-zoc-effort-control={value}
          // The name carries the value, because below 420px the value text is gone from the trigger and
          // the icon alone would leave a screen-reader user without it.
          aria-label={`Effort: ${value}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5",
            "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-[color:var(--zoc-agent-strong)]",
            className,
          )}
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          <Gauge aria-hidden className="size-3 shrink-0" />
          {/* Dropped below 420px by the container rule: everything discretionary degrades first. */}
          <span className="zoc-effort-value">{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-1"
        data-zoc-effort-popover=""
        style={{ backgroundColor: "var(--zoc-elev-2)", borderColor: "var(--zoc-border)" }}
      >
        <div role="radiogroup" aria-label="Effort" className="flex flex-col">
          {ITEMS.map((item) => (
            <button
              key={item.effort}
              type="button"
              role="radio"
              aria-checked={value === item.effort}
              data-zoc-effort-item={item.effort}
              onClick={() => {
                onChange(item.effort);
              }}
              className="flex flex-col items-start gap-0.5 rounded-[var(--zoc-radius-chip)] px-2 py-1 text-left hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            >
              <span
                style={{
                  color: value === item.effort ? "var(--zoc-text)" : "var(--zoc-text-secondary)",
                  fontSize: "var(--zoc-text-meta)",
                }}
              >
                {item.label}
              </span>
              <span style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}>
                {item.description}
              </span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
