/**
 * The compaction row — zoc-agent-chat-rebuild R34.3, R34.6, R34.7, task 16.3.
 *
 * This is what replaces the retired `ContextCompressedEvent` banner, and **the banner stays
 * retired**. The reasoning against it holds: a modal-weight strip announcing an automatic action
 * the user did not trigger and cannot undo is noise, and it occupies the panel's most valuable row
 * to say one sentence once. The reasoning against any *record* does not hold, and that is the
 * distinction Amendment 1 draws — compaction is the one automatic action that silently changes
 * what the model can see, so a transcript with no trace of it is a transcript that lies about its
 * own contents.
 *
 * So: an expandable transcript row, activity tier, ordered by its `seq` like every other part.
 *
 * ## Three consequences of it being a part rather than chrome
 *
 * **Position is free.** R34.3 and R34.6 both want the row *in the position of the folded turns*,
 * and a part in the transcript is already there — a reopened Session renders it where it happened
 * with no restore logic, because there is no state outside the transcript to restore.
 *
 * **The folded turns are still above it.** Compaction changed what the model sees, not what the
 * transcript contains, so the row reads as a divider that explains itself rather than as a
 * replacement for missing content.
 *
 * **Activity tier, not decision.** A card with elevation would give an automatic action the same
 * visual weight as an approval, which is the mistake the banner made in a different shape.
 *
 * ## The summary is read-only, and that is a requirement rather than a simplification
 *
 * R34.7: standing instruction text is the rules editor's job (34.1). An editable summary would let
 * a user rewrite what the model believes happened, which is a different feature wearing this one's
 * clothes. It is rendered as pre-wrapped plain text rather than through the markdown pipeline —
 * inert by construction rather than by policy, and the same call `UserTurnRow` makes: a summary is
 * prose, and passing it through markdown would silently reinterpret a path or a leading `#` in it.
 */
import { useState } from "react";
import { ChevronRight, FoldVertical } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { CompactionPart } from "@zoc-studio/shared-types";
import { formatTokens } from "./usage-figures";

export interface CompactionRowProps {
  compaction: CompactionPart;
  /**
   * Turns a folded message id into something a reader recognises.
   *
   * Optional, and the fallback is the id itself. The part carries `foldedMessageIds` and nothing
   * more — it is a wire record, not a view model — so only the transcript holds the messages those
   * ids name. Passing a resolver in is what makes R34.3's "folded turn list" a list of turns
   * rather than a list of UUIDs, without this row reaching into a store.
   */
  resolveFoldedTurn?: (messageId: string) => string | undefined;
  className?: string;
}

export function CompactionRow({ compaction, resolveFoldedTurn, className }: CompactionRowProps) {
  const [open, setOpen] = useState(false);
  const { foldedTurnCount, contextTokensBefore, contextTokensAfter, foldedMessageIds, summary } =
    compaction;

  const turnWord = foldedTurnCount === 1 ? "turn" : "turns";
  const headline = `Folded ${String(foldedTurnCount)} earlier ${turnWord}`;
  const tokens = `${formatTokens(contextTokensBefore)} → ${formatTokens(contextTokensAfter)} tokens`;

  return (
    <div
      className={cn("flex flex-col", className)}
      style={{ paddingLeft: "var(--zoc-rail-inset)", gap: "var(--zoc-row-gap-tight)" }}
      data-zoc-row="compaction"
      data-zoc-compaction-id={compaction.compactionId}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex w-full items-baseline gap-1.5 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 text-left hover:bg-[var(--zoc-row-bg)]"
          data-zoc-compaction-trigger=""
          // Both facts in the name, so the collapsed row is complete to a screen reader without
          // being expanded — which is the whole claim R34.3's "one collapsed row" makes.
          aria-label={`${headline}, ${tokens}`}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 translate-y-[0.15em] transition-transform zoc-transition-row-expand",
              open && "rotate-90",
            )}
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <FoldVertical
            aria-hidden
            className="size-3 shrink-0 translate-y-[0.15em]"
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <span
            data-zoc-compaction-headline=""
            style={{
              color: "var(--zoc-text-muted)",
              fontSize: "var(--zoc-text-meta)",
              lineHeight: "var(--zoc-leading-meta)",
            }}
          >
            {headline}
          </span>
          <span aria-hidden style={{ color: "var(--zoc-text-faint)" }}>
            ·
          </span>
          <span
            className="font-mono tabular-nums"
            data-zoc-compaction-tokens=""
            style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
          >
            {tokens}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent data-zoc-compaction-detail="">
          <div
            className="mt-1 flex flex-col gap-2 border-l pl-3"
            style={{ borderColor: "var(--zoc-border)" }}
          >
            <div className="flex flex-col gap-0.5">
              <span
                className="font-mono uppercase"
                style={{
                  color: "var(--zoc-text-faint)",
                  fontSize: "var(--zoc-text-label)",
                  letterSpacing: "var(--zoc-tracking-label)",
                }}
              >
                folded turns
              </span>
              <ul className="flex flex-col gap-0.5" data-zoc-compaction-turns="">
                {foldedMessageIds.map((messageId) => (
                  <li
                    key={messageId}
                    className="truncate"
                    data-zoc-compaction-turn={messageId}
                    title={messageId}
                    style={{
                      color: "var(--zoc-text-secondary)",
                      fontSize: "var(--zoc-text-meta)",
                      lineHeight: "var(--zoc-leading-meta)",
                    }}
                  >
                    {resolveFoldedTurn?.(messageId) ?? messageId}
                  </li>
                ))}
              </ul>
            </div>

            <div className="flex flex-col gap-0.5">
              <span
                className="font-mono uppercase"
                style={{
                  color: "var(--zoc-text-faint)",
                  fontSize: "var(--zoc-text-label)",
                  letterSpacing: "var(--zoc-tracking-label)",
                }}
              >
                summary
              </span>
              {/* Read-only prose (R34.7): no textarea, no edit control, no markdown pass. */}
              <p
                className="whitespace-pre-wrap break-words"
                data-zoc-compaction-summary=""
                style={{
                  color: "var(--zoc-text-secondary)",
                  fontSize: "var(--zoc-text-meta)",
                  lineHeight: "var(--zoc-leading-meta)",
                }}
              >
                {summary}
              </p>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
