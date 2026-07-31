/**
 * The mention popover — zoc-agent-chat-rebuild R12.1, R12.2, R12.4, task 20.2.
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
 * ## Why selection is the composer's state and not `cmdk`'s
 *
 * The arrows are pressed in the textarea, which keeps focus the whole time — the popover never takes it,
 * because taking focus away from a textarea mid-sentence is how a picker loses a user's place. So the
 * highlighted row is a prop, and Property 26's "stays in range" is a claim about `nextSelection` rather
 * than about a library's internals.
 */
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
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
  /** Index into `results`, or `-1` for no selection. */
  selected: number;
  onSelect: (result: MentionResult) => void;
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
  onOpenChange,
  children,
  className,
}: MentionPopoverProps) {
  const groups = groupByCategory(results);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        // Focus stays in the textarea: the user is mid-sentence, and the arrows are already routed there.
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
        <Command shouldFilter={false} className="bg-transparent">
          <CommandList className="max-h-72">
            {results.length === 0 ? (
              <CommandEmpty data-zoc-mention-empty="">No matching context.</CommandEmpty>
            ) : null}
            {groups.map((group) => (
              <CommandGroup
                key={group.category}
                heading={CATEGORY_LABELS[group.category]}
                data-zoc-mention-group={group.category}
              >
                {group.results.map((result) => {
                  const index = results.indexOf(result);
                  return (
                    <CommandItem
                      key={result.candidate.id}
                      value={result.candidate.id}
                      // `cmdk`'s own selection is not used, so the highlight is driven by the prop and is
                      // readable by a test without asking the library what it thinks.
                      data-zoc-mention-item={result.candidate.id}
                      data-selected={index === selected ? "" : undefined}
                      aria-selected={index === selected}
                      onSelect={() => {
                        onSelect(result);
                      }}
                      className={cn(
                        "flex items-baseline gap-2",
                        index === selected && "bg-[color:var(--zoc-row-bg)]",
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
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
