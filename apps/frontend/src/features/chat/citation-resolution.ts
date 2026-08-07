/** Pure citation resolution and markdown annotation for `AnswerRow`. */
/** Feature: zoc-agent-chat-rebuild, task 36.4 (R33.6, R33.7). */

import type { Citation, VisitedSource } from "@zoc-studio/shared-types";

import { isSafeUrl } from "./markdown/sanitize";

export type CitationResolutionMode = "offset" | "quote" | "trailing";

export interface ResolvedCitation {
  readonly citation: Citation;
  readonly source: VisitedSource & { readonly url: string };
  readonly mode: CitationResolutionMode;
  readonly start?: number;
  readonly end?: number;
}

export interface CitationResolution {
  readonly inline: readonly ResolvedCitation[];
  readonly trailing: readonly ResolvedCitation[];
}

function linkableSource(
  source: VisitedSource | undefined,
): (VisitedSource & { readonly url: string }) | null {
  if (source?.kind !== "url" || typeof source.url !== "string" || !isSafeUrl(source.url)) {
    return null;
  }
  return source as VisitedSource & { readonly url: string };
}

/** Resolve offsets first, then the carried quote, then preserve the citation as trailing. */
export function resolveCitations(
  text: string,
  citations: readonly Citation[],
  sources: readonly VisitedSource[],
): CitationResolution {
  const byId = new Map(sources.map((source) => [source.sourceId, source]));
  const inline: ResolvedCitation[] = [];
  const trailing: ResolvedCitation[] = [];

  for (const citation of citations) {
    const source = linkableSource(byId.get(citation.sourceId));
    if (source === null) continue;

    const offsetResolves =
      citation.start >= 0 &&
      citation.end > citation.start &&
      citation.end <= text.length &&
      (citation.quote.length === 0 || text.slice(citation.start, citation.end) === citation.quote);
    if (offsetResolves) {
      inline.push({
        citation,
        source,
        mode: "offset",
        start: citation.start,
        end: citation.end,
      });
      continue;
    }

    const quoteStart = citation.quote.length === 0 ? -1 : text.indexOf(citation.quote);
    if (quoteStart >= 0) {
      inline.push({
        citation,
        source,
        mode: "quote",
        start: quoteStart,
        end: quoteStart + citation.quote.length,
      });
      continue;
    }

    trailing.push({ citation, source, mode: "trailing" });
  }

  // Markdown links cannot overlap. Keep the first resolved span inline and
  // preserve every colliding citation through the trailing degradation path.
  inline.sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
  const nonOverlapping: ResolvedCitation[] = [];
  let cursor = -1;
  for (const resolved of inline) {
    const start = resolved.start ?? 0;
    const end = resolved.end ?? start;
    if (start < cursor) trailing.push({ ...resolved, mode: "trailing" });
    else {
      nonOverlapping.push(resolved);
      cursor = end;
    }
  }

  return { inline: nonOverlapping, trailing };
}

function markdownLabel(text: string): string {
  return text.replace(/([\\\[\]])/g, "\\$1");
}

function markdownDestination(url: string): string {
  return url.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Wrap resolved spans without changing their visible label text. */
export function annotateCitationLinks(text: string, links: readonly ResolvedCitation[]): string {
  let annotated = text;
  const descending = [...links].sort((left, right) => (right.start ?? 0) - (left.start ?? 0));
  for (const link of descending) {
    const start = link.start;
    const end = link.end;
    if (start === undefined || end === undefined || end <= start) continue;
    const label = markdownLabel(text.slice(start, end));
    const destination = markdownDestination(link.source.url);
    annotated = `${annotated.slice(0, start)}[${label}](${destination})${annotated.slice(end)}`;
  }
  return annotated;
}
