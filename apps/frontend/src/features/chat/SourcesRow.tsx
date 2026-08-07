/** Expandable activity-tier row for provider-native web-search sources. */
/** Feature: zoc-agent-chat-rebuild, task 36.4 (R33.6). */

import { useState } from "react";
import { ChevronRight, FileText, Globe2 } from "lucide-react";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { SourcePart, VisitedSource } from "@zoc-studio/shared-types";
import { isSafeUrl } from "./markdown/sanitize";

export interface SourcesRowProps {
  source: SourcePart;
  className?: string;
}

function sourceLabel(source: VisitedSource): string {
  if (typeof source.title === "string" && source.title.length > 0) return source.title;
  if (typeof source.url === "string" && source.url.length > 0) return source.url;
  return source.kind === "document" ? "Document" : "Source";
}

function safeSourceUrl(source: VisitedSource): string | null {
  return typeof source.url === "string" && isSafeUrl(source.url) ? source.url : null;
}

function hostOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function SourcesRow({ source, className }: SourcesRowProps) {
  const [open, setOpen] = useState(false);
  const count = source.sources.length;
  const headline = `Searched the web · ${String(count)} ${count === 1 ? "source" : "sources"}`;

  return (
    <div
      className={cn("flex flex-col", className)}
      style={{ paddingLeft: "var(--zoc-rail-inset)", gap: "var(--zoc-row-gap-tight)" }}
      data-zoc-row="sources"
      data-zoc-source=""
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="flex w-full items-center gap-1.5 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 text-left hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
          aria-label={headline}
          data-zoc-sources-trigger=""
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "size-3 shrink-0 transition-transform zoc-transition-row-expand",
              open && "rotate-90",
            )}
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <Globe2
            aria-hidden
            className="size-3 shrink-0"
            style={{ color: "var(--zoc-text-faint)" }}
          />
          <span
            style={{
              color: "var(--zoc-text-muted)",
              fontSize: "var(--zoc-text-meta)",
              lineHeight: "var(--zoc-leading-meta)",
            }}
          >
            {headline}
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent data-zoc-sources-detail="">
          <ul
            className="mt-1 flex flex-col gap-1 border-l pl-3"
            style={{ borderColor: "var(--zoc-border)" }}
          >
            {source.sources.map((item) => {
              const url = safeSourceUrl(item);
              const host = hostOf(url);
              const content = (
                <>
                  {item.kind === "url" ? (
                    <Globe2 aria-hidden className="mt-0.5 size-3 shrink-0" />
                  ) : (
                    <FileText aria-hidden className="mt-0.5 size-3 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{sourceLabel(item)}</span>
                  {host === null ? null : (
                    <span
                      className="shrink-0 font-mono"
                      style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
                    >
                      {host}
                    </span>
                  )}
                </>
              );
              return (
                <li key={item.sourceId} data-zoc-source-id={item.sourceId}>
                  {url === null ? (
                    <span
                      className="flex min-w-0 items-start gap-2 px-1 py-0.5"
                      style={{
                        color: "var(--zoc-text-secondary)",
                        fontSize: "var(--zoc-text-meta)",
                      }}
                    >
                      {content}
                    </span>
                  ) : (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer nofollow"
                      className="flex min-w-0 items-start gap-2 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 hover:bg-[var(--zoc-row-bg)]"
                      style={{
                        color: "var(--zoc-text-secondary)",
                        fontSize: "var(--zoc-text-meta)",
                      }}
                    >
                      {content}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
