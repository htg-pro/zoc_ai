/**
 * The context meter and the overflow gate — zoc-agent-chat-rebuild R12.5, R12.6, R12.8, R12.9, R12.10,
 * R34.4, task 20.3.
 *
 * `12.4k / 200k` beside the four context facts, and at overflow a button that opens the dialog for fixing
 * it. Every figure comes from one call to `contextFigures`, in one `useMemo`, keyed on the model — which
 * is R12.10 implemented rather than promised.
 *
 * ## Why a memo and not an effect
 *
 * R12.10 says the figures are recomputed against the newly selected model's window *before* they are
 * displayed again. An effect that recomputed after render would paint exactly one frame of the previous
 * model's count against the new model's limit, which is the state the requirement forbids — and a single
 * frame is enough for a screenshot, a screen reader, and Property 83's render recorder. Deriving during
 * render makes the wrong pairing unrepresentable: the count and the limit come out of the same call.
 *
 * ## Why the two thresholds are different numbers
 *
 * The meter warns at 90% (`lib/context-usage.ts`'s flag) and the runtime compacts at 85% (9.5). Neither is
 * a stale copy of the other: 85% is where the runtime *acts*, and it fires early precisely so there is
 * headroom to summarise in; 90% is where the user is told the next attachment may not fit. Aligning them
 * would mean the warning only ever appeared after compaction had already resolved the thing it warns
 * about.
 *
 * ## Why the overflow dialog pre-selects
 *
 * R12.6 asks for "offer removing the largest attachment first", which is an action rather than a hint. The
 * dialog opens with the smallest set of largest attachments that clears the overflow already ticked, so
 * the default action is the one the requirement names and the arithmetic is the surface's.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, Scissors } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  censusSentence,
  contextFigures,
  formatTokens,
  removalCandidates,
  removalToClear,
  type ContextCensus,
  type ModelReference,
} from "./context-figures";
import type { ResolvedMention } from "../store";

export interface ContextMeterProps {
  model: ModelReference;
  census: ContextCensus;
  mentions: readonly ResolvedMention[];
  /** Remove attachments the user chose in the overflow dialog. */
  onRemoveMentions: (ids: readonly string[]) => void;
  /** `POST /v1/sessions/:id/compact` (R34.4). Absent means the control is not offered. */
  onCompact?: () => void;
  className?: string;
}

export function ContextMeter({
  model,
  census,
  mentions,
  onRemoveMentions,
  onCompact,
  className,
}: ContextMeterProps) {
  // One derivation, during render. See the header: an effect here would paint a frame of the old count
  // against the new limit.
  const figures = useMemo(
    () => contextFigures({ model, census, mentions }),
    [model, census, mentions],
  );

  const [dialogOpen, setDialogOpen] = useState(false);
  const candidates = useMemo(() => removalCandidates(mentions), [mentions]);
  const suggested = useMemo(() => removalToClear(figures, mentions), [figures, mentions]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  const openDialog = () => {
    // Re-seeded on every open rather than held in sync: what "the largest that clears it" means changes
    // as chips come and go, and a stale tick would remove the wrong attachment.
    setSelected(new Set(suggested.map((mention) => mention.id)));
    setDialogOpen(true);
  };

  const summary = `${formatTokens(figures.usage.consumed)} / ${formatTokens(model.contextLimit)}`;
  const tone = figures.overflowing
    ? "var(--zoc-error)"
    : figures.usage.warning
      ? "var(--zoc-ember)"
      : "var(--zoc-text-muted)";

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {/*
        The figures and the model they were computed against live on one element, so a reader — and
        Property 83's recorder — can never see a count from one model beside another's limit.
      */}
      <button
        type="button"
        data-zoc-context-meter=""
        data-zoc-context-model={model.modelId}
        data-zoc-context-limit={String(model.contextLimit)}
        data-zoc-context-consumed={String(figures.usage.consumed)}
        data-zoc-context-estimated={figures.estimated ? "" : undefined}
        data-zoc-context-overflowing={figures.overflowing ? "" : undefined}
        // The name carries every fact R12.8 asks for, because the visible line is four words and the
        // census is four facts.
        aria-label={`Context: ${summary}. ${censusSentence(figures)}`}
        title={censusSentence(figures)}
        disabled={!figures.overflowing}
        onClick={openDialog}
        className={cn(
          "inline-flex items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 tabular-nums",
          figures.overflowing
            ? "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            : "cursor-default",
        )}
        style={{ color: tone, fontSize: "var(--zoc-text-label)" }}
      >
        {figures.overflowing || figures.usage.warning ? (
          <AlertTriangle aria-hidden className="size-3 shrink-0" />
        ) : null}
        {summary}
        {/*
          R12.9: a figure the surface computed, not one the runtime reported. Marked in the line rather
          than only in the tooltip, because the distinction changes how much the number can be trusted.
        */}
        {figures.estimated ? <span data-zoc-context-estimate-mark="">est.</span> : null}
      </button>

      <span
        data-zoc-context-census=""
        style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
      >
        {census.messagesInContext}/{census.sessionMessageCount} msgs
        {census.messagesOutOfWindow > 0 ? ` · ${String(census.messagesOutOfWindow)} out` : ""}
        {census.summaryActive ? " · summary" : ""}
      </span>

      {onCompact === undefined ? null : (
        <button
          type="button"
          data-zoc-context-compact=""
          // Offered whatever the ratio is: a user who can see the pressure should have an action other
          // than waiting for the automatic trigger (R34.4).
          aria-label="Compact the conversation now"
          onClick={onCompact}
          className="inline-flex items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
        >
          <Scissors aria-hidden className="size-3 shrink-0" />
          Compact
        </button>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent data-zoc-overflow-dialog="">
          <DialogHeader>
            <DialogTitle>Too much context</DialogTitle>
            <DialogDescription>
              The attached context is {formatTokens(figures.overflowBy)} over{" "}
              {model.modelId}&apos;s window. Remove enough to send.
            </DialogDescription>
          </DialogHeader>

          <ul role="list" className="flex flex-col gap-1">
            {candidates.map((mention) => (
              <li
                key={mention.id}
                className="flex items-center gap-2"
                data-zoc-overflow-candidate={mention.ref}
              >
                <Checkbox
                  checked={selected.has(mention.id)}
                  aria-label={`Remove ${mention.ref}, ${formatTokens(mention.estimatedTokens)} tokens`}
                  onCheckedChange={(checked) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked === true) next.add(mention.id);
                      else next.delete(mention.id);
                      return next;
                    });
                  }}
                />
                <span
                  className="min-w-0 flex-1 truncate font-mono"
                  style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
                >
                  {mention.ref}
                </span>
                <span
                  className="shrink-0 tabular-nums"
                  style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
                >
                  {formatTokens(mention.estimatedTokens)}
                </span>
              </li>
            ))}
          </ul>

          <DialogFooter>
            <button
              type="button"
              data-zoc-overflow-remove=""
              disabled={selected.size === 0}
              onClick={() => {
                onRemoveMentions([...selected]);
                setDialogOpen(false);
              }}
              className="rounded-[var(--zoc-radius-chip)] border px-2 py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
              style={{
                borderColor: selected.size === 0 ? "var(--zoc-border)" : "var(--zoc-agent)",
                color: selected.size === 0 ? "var(--zoc-text-faint)" : "var(--zoc-text)",
                fontSize: "var(--zoc-text-label)",
              }}
            >
              Remove {selected.size === 1 ? "1 attachment" : `${String(selected.size)} attachments`}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
