/**
 * The historical row — zoc-agent-chat-rebuild R23.2, task 16.3.
 *
 * Feature: zoc-agent-chat-rebuild, task 16.3 (R23.2).
 *
 * A pre-upgrade conversation contains legacy events with no Message_Part equivalent. R23.2 says
 * the surface renders a neutral row for them "rather than failing", and this is that row: one muted
 * line with an italic label naming the legacy event kind, its time, and the original record verbatim
 * on expand.
 *
 * **Verbatim is the design.** The row preserves the record without pretending the new surface
 * understands it — a synthesised interpretation of a `review` or a `test-results` payload would be
 * this component inventing a rendering for a contract that no longer exists, and getting it subtly
 * wrong on somebody's real history.
 *
 * **The label is italic because it is not the agent's voice.** Everything else in the transcript
 * was said by the user, the model, or the tools; this was said by a version of the app that no
 * longer runs, and the italic is the one cue that distinguishes a preserved record from live output.
 *
 * **`--zoc-text-muted`, not the taxonomy's `--zoc-text-faint`.** Same call `UnknownPartRow` makes:
 * faint measures below 4.5:1 on every panel surface, and a label and a timestamp are informational
 * text. The glyph and the section labels stay faint, which is faint's legitimate role.
 *
 * **Collapsing lives in `historical-rows.ts`.** Which events share a row is arithmetic over a
 * sequence — consecutive, same-Run `stage` events — so it is a pure function, and this file maps
 * over its result.
 */
import { useState } from "react";
import { ChevronRight, History } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  formatHistoricalRaw,
  formatHistoricalTime,
  type HistoricalEvent,
  type HistoricalItem,
} from "./historical-rows";

export interface HistoricalRowProps {
  item: HistoricalItem;
  className?: string;
}

/** The label, the count when several events share the row, and the time. */
function summarise(item: HistoricalItem): {
  label: string;
  count: number;
  ts: string;
  members: readonly HistoricalEvent[];
} {
  if (item.kind === "stage-run") {
    return {
      label: item.latest.label,
      count: item.members.length,
      ts: item.latest.ts,
      members: item.members,
    };
  }
  return { label: item.event.label, count: 1, ts: item.event.ts, members: [item.event] };
}

export function HistoricalRow({ item, className }: HistoricalRowProps) {
  const [open, setOpen] = useState(false);
  const { label, count, ts, members } = summarise(item);
  const time = formatHistoricalTime(ts);
  const collapsed = count > 1;

  return (
    <div
      className={cn("flex flex-col", className)}
      style={{ paddingLeft: "var(--zoc-rail-inset)" }}
      data-zoc-row="historical"
      data-zoc-historical-kind={item.kind === "stage-run" ? "stage-run" : item.event.kind}
      data-zoc-historical-count={String(count)}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex w-full items-baseline gap-1.5 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 text-left hover:bg-[var(--zoc-row-bg)]"
          data-zoc-historical-trigger=""
          aria-label={`${label}${collapsed ? `, ${String(count)} events` : ""}${time === "" ? "" : `, ${time}`}, from a previous version`}
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 translate-y-[0.15em] transition-transform zoc-transition-row-expand",
              open && "rotate-90",
            )}
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <History
            aria-hidden
            className="size-3 shrink-0 translate-y-[0.15em]"
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <span
            className="truncate italic"
            data-zoc-historical-label=""
            style={{
              color: "var(--zoc-text-muted)",
              fontSize: "var(--zoc-text-meta)",
              lineHeight: "var(--zoc-leading-meta)",
            }}
          >
            {label}
          </span>
          {collapsed ? (
            <span
              className="shrink-0 font-mono tabular-nums"
              data-zoc-historical-collapsed={String(count)}
              style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
            >
              {count} ×
            </span>
          ) : null}
          {time === "" ? null : (
            <span
              className="ml-auto shrink-0 font-mono tabular-nums"
              data-zoc-historical-time=""
              style={{ color: "var(--zoc-text-muted)", fontSize: "var(--zoc-text-label)" }}
            >
              {time}
            </span>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent data-zoc-historical-detail="">
          <div
            className="mt-1 flex flex-col gap-2 border-l pl-3"
            style={{ borderColor: "var(--zoc-border)" }}
          >
            {members.map((member) => (
              <pre
                key={member.id}
                className="overflow-x-auto whitespace-pre-wrap break-words font-mono"
                data-zoc-historical-raw={member.id}
                style={{
                  color: "var(--zoc-text-secondary)",
                  fontSize: "var(--zoc-text-meta)",
                  lineHeight: "var(--zoc-leading-meta)",
                }}
              >
                {formatHistoricalRaw(member.raw)}
              </pre>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
