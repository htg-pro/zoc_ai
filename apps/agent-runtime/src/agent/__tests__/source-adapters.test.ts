/** Feature: zoc-agent-chat-rebuild, task 36.3 (R7.10, R33.6, R33.9). */
import { describe, expect, it } from "vitest";

import { SourceAccumulator } from "../source-adapters.ts";

describe("provider source adapters", () => {
  it("normalises OpenAI URL annotations onto the native source id", () => {
    const adapter = new SourceAccumulator();
    adapter.ingestChunk("openai", { type: "text-start", id: "answer-1" });
    adapter.ingestChunk("openai", {
      type: "text-delta",
      id: "answer-1",
      delta: "Current release notes",
    });
    adapter.ingestChunk("openai", {
      type: "source-url",
      sourceId: "openai-source-1",
      url: "https://example.test/openai",
      title: "OpenAI result",
    });
    adapter.ingestChunk("openai", {
      type: "text-end",
      id: "answer-1",
      providerMetadata: {
        openai: {
          annotations: [
            {
              type: "url_citation",
              url: "https://example.test/openai",
              title: "OpenAI result",
              start_index: 0,
              end_index: 7,
            },
          ],
        },
      },
    });

    expect(adapter.snapshot()).toEqual({
      sources: [
        {
          sourceId: "openai-source-1",
          kind: "url",
          url: "https://example.test/openai",
          title: "OpenAI result",
          mediaType: null,
        },
      ],
      citations: [
        {
          sourceId: "openai-source-1",
          partId: "answer-1",
          start: 0,
          end: 7,
          quote: "Current",
        },
      ],
    });
  });

  it("normalises Anthropic cited text and locates its span", () => {
    const adapter = new SourceAccumulator();
    adapter.ingestChunk("anthropic", { type: "text-start", id: "answer-2" });
    adapter.ingestChunk("anthropic", {
      type: "text-delta",
      id: "answer-2",
      delta: "The launch happened today.",
    });
    adapter.ingestChunk("anthropic", {
      type: "source-url",
      sourceId: "anthropic-source-1",
      url: "https://example.test/anthropic",
      title: "Anthropic result",
    });
    adapter.ingestChunk("anthropic", {
      type: "text-end",
      id: "answer-2",
      providerMetadata: {
        anthropic: {
          citations: [
            {
              type: "web_search_result_location",
              url: "https://example.test/anthropic",
              title: "Anthropic result",
              cited_text: "launch happened",
            },
          ],
        },
      },
    });

    expect(adapter.snapshot().citations[0]).toMatchObject({
      sourceId: "anthropic-source-1",
      partId: "answer-2",
      start: 4,
      end: 19,
      quote: "launch happened",
    });
  });

  it("normalises Google grounding chunks and support indices", () => {
    const adapter = new SourceAccumulator();
    adapter.ingestChunk("google-ai-studio", { type: "text-start", id: "answer-3" });
    adapter.ingestChunk("google-ai-studio", {
      type: "text-delta",
      id: "answer-3",
      delta: "Gemini cites two sources.",
    });
    adapter.ingestChunk("google-ai-studio", {
      type: "source-url",
      sourceId: "google-source-1",
      url: "https://example.test/google",
      title: "Google result",
    });
    adapter.ingestResult("google-ai-studio", {
      providerMetadata: {
        google: {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://example.test/google", title: "Google result" } },
            ],
            groundingSupports: [
              {
                segment: { startIndex: 0, endIndex: 6, text: "Gemini" },
                groundingChunkIndices: [0],
              },
            ],
          },
        },
      },
    });

    expect(adapter.snapshot()).toMatchObject({
      sources: [{ sourceId: "google-source-1", url: "https://example.test/google" }],
      citations: [
        {
          sourceId: "google-source-1",
          partId: "answer-3",
          start: 0,
          end: 6,
          quote: "Gemini",
        },
      ],
    });
  });
});
