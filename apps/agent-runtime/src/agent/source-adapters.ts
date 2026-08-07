/** Provider source/citation normalization for the reconciled `SourcePart`. */
/** Feature: zoc-agent-chat-rebuild, task 36.3 (R7.10, R33.6, R33.9). */

import type { Citation, SourcePart, VisitedSource } from "@zoc-studio/shared-types";

type UnknownRecord = Record<string, unknown>;

function recordOf(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null ? (value as UnknownRecord) : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function providerBucket(metadata: unknown, prefix: string): UnknownRecord | null {
  const root = recordOf(metadata);
  if (root === null) return null;
  const exact = recordOf(root[prefix]);
  if (exact !== null) return exact;
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith(`${prefix}.`)) {
      const bucket = recordOf(value);
      if (bucket !== null) return bucket;
    }
  }
  return null;
}

function stableId(provider: string, seed: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${provider}:${(hash >>> 0).toString(36)}`;
}

function sourceFromResult(value: unknown): VisitedSource | null {
  const source = recordOf(value);
  if (source === null) return null;
  const sourceType = stringOf(source.sourceType) ?? stringOf(source.type);
  const sourceId = stringOf(source.id) ?? stringOf(source.sourceId);
  if (sourceType === "url") {
    const url = stringOf(source.url);
    if (url === undefined) return null;
    return {
      sourceId: sourceId ?? stableId("source", url),
      kind: "url",
      url,
      title: stringOf(source.title) ?? null,
      mediaType: null,
    };
  }
  if (sourceType === "document") {
    return {
      sourceId: sourceId ?? stableId("document", stringOf(source.title) ?? "document"),
      kind: "document",
      url: null,
      title: stringOf(source.title) ?? stringOf(source.filename) ?? null,
      mediaType: stringOf(source.mediaType) ?? null,
    };
  }
  return null;
}

export type SourceSnapshot = Pick<SourcePart, "sources" | "citations">;

/**
 * Accumulates every source batch for one Run. Native source chunks provide the
 * IDs persisted by the AI SDK; provider metadata supplies citation spans.
 */
export class SourceAccumulator {
  private readonly sources = new Map<string, VisitedSource>();
  private readonly sourceIdByUrl = new Map<string, string>();
  private readonly citations = new Map<string, Citation>();
  private readonly textByPart = new Map<string, string>();
  private latestTextPartId: string | null = null;
  private revision = 0;

  get version(): number {
    return this.revision;
  }

  snapshot(): SourceSnapshot {
    return {
      sources: [...this.sources.values()].map((source) => ({ ...source })),
      citations: [...this.citations.values()].map((citation) => ({ ...citation })),
    };
  }

  ingestChunk(providerId: string, chunkValue: unknown): boolean {
    const before = this.revision;
    const chunk = recordOf(chunkValue);
    if (chunk === null) return false;
    const type = stringOf(chunk.type);

    if (type === "text-start") {
      const id = stringOf(chunk.id);
      if (id !== undefined) {
        this.latestTextPartId = id;
        if (!this.textByPart.has(id)) this.textByPart.set(id, "");
      }
    } else if (type === "text-delta") {
      const id = stringOf(chunk.id);
      if (id !== undefined) {
        this.latestTextPartId = id;
        this.textByPart.set(id, `${this.textByPart.get(id) ?? ""}${stringOf(chunk.delta) ?? ""}`);
      }
    } else if (type === "text-end") {
      const id = stringOf(chunk.id);
      if (id !== undefined) {
        this.latestTextPartId = id;
        this.ingestProviderMetadata(providerId, chunk.providerMetadata, id);
      }
    } else if (type === "source-url") {
      const url = stringOf(chunk.url);
      const sourceId = stringOf(chunk.sourceId);
      if (url !== undefined && sourceId !== undefined) {
        this.addSource({
          sourceId,
          kind: "url",
          url,
          title: stringOf(chunk.title) ?? null,
          mediaType: null,
        });
      }
    } else if (type === "source-document") {
      const sourceId = stringOf(chunk.sourceId);
      if (sourceId !== undefined) {
        this.addSource({
          sourceId,
          kind: "document",
          url: null,
          title: stringOf(chunk.title) ?? stringOf(chunk.filename) ?? null,
          mediaType: stringOf(chunk.mediaType) ?? null,
        });
      }
    }

    return this.revision !== before;
  }

  ingestResult(
    providerId: string,
    input: { sources?: unknown; providerMetadata?: unknown },
  ): boolean {
    const before = this.revision;
    for (const raw of arrayOf(input.sources)) {
      const source = sourceFromResult(raw);
      if (source !== null) this.addSource(source);
    }
    this.ingestProviderMetadata(
      providerId,
      input.providerMetadata,
      this.latestTextPartId ?? undefined,
    );
    return this.revision !== before;
  }

  private addSource(source: VisitedSource): string {
    const url = source.url ?? undefined;
    const existingId = url === undefined ? undefined : this.sourceIdByUrl.get(url);
    if (existingId !== undefined) {
      const existing = this.sources.get(existingId);
      if (existing !== undefined && existing.title == null && source.title != null) {
        this.sources.set(existingId, { ...existing, title: source.title });
        this.revision += 1;
      }
      return existingId;
    }

    if (!this.sources.has(source.sourceId)) {
      this.sources.set(source.sourceId, source);
      if (url !== undefined) this.sourceIdByUrl.set(url, source.sourceId);
      this.revision += 1;
    }
    return source.sourceId;
  }

  private addUrlSource(
    provider: string,
    url: string,
    title?: string,
    preferredId?: string,
  ): string {
    return this.addSource({
      sourceId: preferredId ?? stableId(provider, url),
      kind: "url",
      url,
      title: title ?? null,
      mediaType: null,
    });
  }

  private addCitation(citation: Citation): void {
    if (!this.sources.has(citation.sourceId)) return;
    const key = [
      citation.sourceId,
      citation.partId,
      citation.start,
      citation.end,
      citation.quote,
    ].join("\0");
    if (this.citations.has(key)) return;
    this.citations.set(key, citation);
    this.revision += 1;
  }

  private ingestProviderMetadata(providerId: string, metadata: unknown, partId?: string): void {
    if (providerId === "openai") this.ingestOpenAi(metadata, partId);
    else if (providerId === "anthropic") this.ingestAnthropic(metadata, partId);
    else if (providerId === "google-ai-studio") this.ingestGoogle(metadata, partId);
  }

  private ingestOpenAi(metadata: unknown, partId?: string): void {
    if (partId === undefined) return;
    const bucket = providerBucket(metadata, "openai");
    for (const raw of arrayOf(bucket?.annotations)) {
      const annotation = recordOf(raw);
      if (annotation === null || stringOf(annotation.type) !== "url_citation") continue;
      const url = stringOf(annotation.url);
      if (url === undefined) continue;
      const sourceId = this.addUrlSource("openai", url, stringOf(annotation.title));
      const text = this.textByPart.get(partId) ?? "";
      const start = numberOf(annotation.start_index) ?? numberOf(annotation.startIndex) ?? 0;
      const end = numberOf(annotation.end_index) ?? numberOf(annotation.endIndex) ?? start;
      this.addCitation({
        sourceId,
        partId,
        start,
        end,
        quote: text.slice(start, end),
      });
    }
  }

  private ingestAnthropic(metadata: unknown, partId?: string): void {
    if (partId === undefined) return;
    const bucket = providerBucket(metadata, "anthropic");
    const text = this.textByPart.get(partId) ?? "";
    for (const raw of arrayOf(bucket?.citations)) {
      const citation = recordOf(raw);
      if (citation === null || stringOf(citation.type) !== "web_search_result_location") continue;
      const url = stringOf(citation.url);
      if (url === undefined) continue;
      const sourceId = this.addUrlSource(
        "anthropic",
        url,
        stringOf(citation.title),
        stringOf(citation.encrypted_index) ?? undefined,
      );
      const quote = stringOf(citation.cited_text) ?? "";
      const start = quote.length === 0 ? 0 : Math.max(0, text.indexOf(quote));
      this.addCitation({ sourceId, partId, start, end: start + quote.length, quote });
    }
  }

  private ingestGoogle(metadata: unknown, partId?: string): void {
    const bucket = providerBucket(metadata, "google");
    const grounding = recordOf(bucket?.groundingMetadata);
    if (grounding === null) return;

    const sourceIds: string[] = [];
    for (const [index, raw] of arrayOf(grounding.groundingChunks).entries()) {
      const web = recordOf(recordOf(raw)?.web);
      const url = stringOf(web?.uri);
      if (url === undefined) {
        sourceIds[index] = "";
        continue;
      }
      sourceIds[index] = this.addUrlSource(
        "google",
        url,
        stringOf(web?.title),
        this.sourceIdByUrl.get(url) ?? `google:${String(index)}`,
      );
    }

    const targetPartId = partId ?? this.latestTextPartId ?? undefined;
    if (targetPartId === undefined) return;
    const text = this.textByPart.get(targetPartId) ?? "";
    for (const raw of arrayOf(grounding.groundingSupports)) {
      const support = recordOf(raw);
      const segment = recordOf(support?.segment);
      if (support === null || segment === null) continue;
      const quote = stringOf(segment.text) ?? stringOf(support.segment_text) ?? "";
      const suppliedStart = numberOf(segment.startIndex) ?? numberOf(segment.start_index);
      const suppliedEnd = numberOf(segment.endIndex) ?? numberOf(segment.end_index);
      const matchedStart = quote.length === 0 ? 0 : Math.max(0, text.indexOf(quote));
      const start = suppliedStart ?? matchedStart;
      const end = suppliedEnd ?? start + quote.length;
      const indices = [
        ...arrayOf(support.groundingChunkIndices),
        ...arrayOf(support.supportChunkIndices),
      ];
      for (const rawIndex of new Set(indices)) {
        const index = numberOf(rawIndex);
        if (index === undefined) continue;
        const sourceId = sourceIds[index];
        if (sourceId === undefined || sourceId.length === 0) continue;
        this.addCitation({ sourceId, partId: targetPartId, start, end, quote });
      }
    }
  }
}
