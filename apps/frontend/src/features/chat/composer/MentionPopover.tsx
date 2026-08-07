/**
 * The mention popover — zoc-agent-chat-rebuild R12.1, R12.2, R12.4, task 20.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 20.2 (R12.1, R12.2, R12.4).
 *
 * Radix `Popover` anchored to the composer, `cmdk` inside it, four categories, results capped at fifty.
 * The list is rendered from {@link MentionResult}s the composer has already filtered — this component
 * neither searches nor debounces, because both are about *when* to ask and it only draws the answer.
 *
 * ## Why `cmdk` with its own filtering switched off
 *
 * `cmdk` gives the app's existing command-palette semantics for free, which is what R12.4's arrow/Enter/
 * Escape model should feel like. What it must not do is filter: its matcher is not `mention-index.ts`'s,
 * so leaving it on would mean two filters disagreeing about what a query matches — with the visible list
 * decided by whichever ran last. `shouldFilter={false}` makes the ranking the model's alone.
 *
 * ## Why the highlight goes *through* `cmdk` rather than around it
 *
 * The composer owns the index — the arrows are pressed in the textarea, which keeps focus the whole time,
 * because taking focus away from a textarea mid-sentence is how a picker loses a user's place. But the
 * *attributes* are `cmdk`'s and cannot be overridden: its `Item` spreads incoming props **before** its own
 * `aria-selected` and `data-selected`, so setting either from a prop is silently dropped and the library
 * goes on highlighting whatever it last selected itself — which produced two highlighted rows, one the
 * arrows moved and one they did not, and an `aria-selected` that named the wrong row to a screen reader.
 *
 * So the index is pushed down as `Command`'s controlled `value` and `cmdk`'s own selection is the single
 * source of truth. `onValueChange` is fed back for the other half of the same problem: `cmdk` moves its
 * selection on pointer-over, so without the return path a hovered row would look chosen while `Enter`
 * inserted the arrowed one.
 *
 * ## Why there is no empty state
 *
 * `Composer` opens this only for a query with results, so a "no matching context" row is unreachable — and
 * deliberately, because R12 asks for no such report and an empty box floating over a half-typed sentence
 * is noise the user has to dismiss. The popover simply stays shut, which is the same thing the whitespace
 * that ends an `@token` does.
 */
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { formatTokens } from "./context-figures";
import { groupByCategory, type MentionCategory, type MentionResult } from "./mention-index";

/** The section headings, in the order R12.1 names them. */
const CATEGORY_LABELS: Readonly<Record<MentionCategory, string>> = {
  files: "Files",
  symbols: "Symbols",
  terminal: "Terminal",
  docs: "Docs",
};

export interface MentionPopoverProps {
  open: boolean;
  /** Already filtered and ranked by `mention-index.ts`. */
  results: readonly MentionResult[];
  /** Index into `results`. Out of range means no row is highlighted. */
  selected: number;
  onSelect: (result: MentionResult) => void;
  /**
   * The list moved its own highlight — a pointer went over a row — carrying the index it moved to.
   *
   * Not an alternative route for the arrow keys, which the textarea owns: this exists so the row `Enter`
   * would insert is the row that looks chosen, whichever input moved it last.
   */
  onHighlight: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  /** The element the popover is positioned against — the composer's box. */
  children: React.ReactNode;
  className?: string;
}

export function MentionPopover({
  open,
  results,
  selected,
  onSelect,
  onHighlight,
  onOpenChange,
  children,
  className,
}: MentionPopoverProps) {
  const groups = groupByCategory(results);
  // `cmdk` matches this against each item's `value`, so the ids have to be the same on both sides.
  const highlighted = results[selected]?.candidate.id ?? "";

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        // Focus stays in the textarea: the user is mid-sentence, and the arrows are already routed there.
        //
        // This is R21.6's one deliberate exception, and it is the combobox pattern rather than a gap. The
        // popover is not a surface the user moves *into* — it is a listbox controlled from the input, which
        // keeps `aria-activedescendant` on the highlighted row. Trapping focus here would mean taking it off
        // the textarea, and the next keystroke of the sentence being typed would go nowhere. The invariant
        // R21.6 protects — focus is never stranded — holds by focus never leaving the composer at all.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
        }}
        data-zoc-mention-popover=""
        className={cn("w-96 p-0", className)}
        style={{
          backgroundColor: "var(--zoc-elev-2)",
          borderColor: "var(--zoc-border)",
        }}
      >
        <Command
          shouldFilter={false}
          value={highlighted}
          onValueChange={(next) => {
            const index = results.findIndex((result) => result.candidate.id === next);
            if (index !== -1 && index !== selected) onHighlight(index);
          }}
          className="bg-transparent"
        >
          <CommandList className="max-h-72">
            {groups.map((group) => (
              <CommandGroup
                key={group.category}
                heading={CATEGORY_LABELS[group.category]}
                data-zoc-mention-group={group.category}
              >
                {group.results.map((result) => (
                  <CommandItem
                    key={result.candidate.id}
                    value={result.candidate.id}
                    data-zoc-mention-item={result.candidate.id}
                    onSelect={() => {
                      onSelect(result);
                    }}
                    className={cn(
                      "flex items-baseline gap-2",
                      // Driven by `cmdk`'s attribute rather than by the index, so the highlight and
                      // `aria-selected` cannot name different rows.
                      "data-[selected=true]:bg-[color:var(--zoc-row-bg)]",
                    )}
                  >
                    <span
                      className="truncate font-mono"
                      style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
                    >
                      {result.candidate.label}
                    </span>
                    {result.candidate.detail === undefined ? null : (
                      <span
                        className="min-w-0 flex-1 truncate font-mono"
                        style={{
                          color: "var(--zoc-text-faint)",
                          fontSize: "var(--zoc-text-label)",
                        }}
                      >
                        {result.candidate.detail}
                      </span>
                    )}
                    <span
                      className="shrink-0 tabular-nums"
                      data-zoc-mention-cost=""
                      style={{
                        color: "var(--zoc-text-muted)",
                        fontSize: "var(--zoc-text-label)",
                      }}
                    >
                      {formatTokens(result.candidate.estimatedTokens)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
