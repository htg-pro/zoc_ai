/** Feature: zoc-agent-chat-rebuild, task 36.5 (R33.1, R33.2, R33.5, R33.7, R33.9). */
import { expect, it } from "vitest";
import { tool } from "ai";
import { MockLanguageModelV3, convertReadableStreamToArray, simulateReadableStream } from "ai/test";
import { z } from "zod";

import { streamRun, type RunContext, type ZocUIChunk } from "../build-agent.ts";
import { COMPLETION_TOOL, type ToolDescriptor } from "../../tools/registry.ts";
import { ErrorCode } from "../../http/errors.ts";
import { NO_WEB_SEARCH_SENTENCE, webSearchToolFor } from "../../tools/web-search.ts";

type StreamPart =
  Awaited<ReturnType<MockLanguageModelV3["doStream"]>>["stream"] extends ReadableStream<infer Part>
    ? Part
    : never;

const completion: ToolDescriptor = {
  name: COMPLETION_TOOL,
  kind: "read",
  description: "",
  tool: tool({ description: "", inputSchema: z.object({ summary: z.string() }) }),
};

function usage(): Extract<StreamPart, { type: "finish" }>["usage"] {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
}

it("streams two source batches into one reconciled SourcePart", async () => {
  const chunks: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Fresh facts" },
    {
      type: "source",
      sourceType: "url",
      id: "source-1",
      url: "https://one.example/fact",
      title: "One",
    },
    {
      type: "source",
      sourceType: "url",
      id: "source-2",
      url: "https://two.example/fact",
      title: "Two",
    },
    {
      type: "text-end",
      id: "answer",
      providerMetadata: {
        openai: {
          annotations: [
            {
              type: "url_citation",
              url: "https://one.example/fact",
              title: "One",
              start_index: 0,
              end_index: 5,
            },
          ],
        },
      },
    },
    { type: "tool-input-start", id: "complete", toolName: COMPLETION_TOOL },
    { type: "tool-input-delta", id: "complete", delta: '{"summary":"done"}' },
    { type: "tool-input-end", id: "complete" },
    {
      type: "tool-call",
      toolCallId: "complete",
      toolName: COMPLETION_TOOL,
      input: '{"summary":"done"}',
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
  ];
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    }),
  });
  let registeredNames: string[] = [];
  const context: RunContext = {
    runId: "run-search",
    sessionId: "session-search",
    messageId: "message-search",
    provider: "openai",
    model: "gpt-5",
    languageModel: model,
    conversationMode: "ask",
    permissionMode: "auto",
    instructions: { instructions: "BASE", appliedSources: [], skipped: [] },
    request: {
      instructions: "BASE",
      pin: null,
      mentions: [],
      toolSchemas: [],
      messages: [{ id: "user", role: "user", text: "latest" }],
      contextLimit: 128_000,
      sessionMessageCount: 1,
    },
    bind: () => ({
      descriptors: [completion],
      providerTools: {
        authorizeWebSearch: async () => true,
        descriptorsFor: (providerTools) => {
          registeredNames = providerTools.map((descriptor) => descriptor.name);
          return [...providerTools, completion];
        },
      },
    }),
  };

  const output = await convertReadableStreamToArray(streamRun(context));
  const sourceChunks = output.filter(
    (chunk): chunk is Extract<ZocUIChunk, { type: "data-zoc-source" }> =>
      chunk.type === "data-zoc-source",
  );
  expect(registeredNames).toEqual(["web_search"]);
  expect(sourceChunks.length).toBeGreaterThanOrEqual(2);
  expect(new Set(sourceChunks.map((chunk) => chunk.id))).toEqual(new Set(["run-search"]));
  expect(sourceChunks.at(-1)?.data.sources).toHaveLength(2);
  expect(sourceChunks.at(-1)?.data.citations[0]).toMatchObject({
    sourceId: "source-1",
    partId: "answer",
    quote: "Fresh",
  });
});

it("adds the unavailable instruction and omits the tool for an unsupported provider", async () => {
  const chunks: StreamPart[] = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "Offline answer" },
    { type: "text-end", id: "answer" },
    { type: "tool-input-start", id: "complete", toolName: COMPLETION_TOOL },
    { type: "tool-input-delta", id: "complete", delta: '{"summary":"done"}' },
    { type: "tool-input-end", id: "complete" },
    {
      type: "tool-call",
      toolCallId: "complete",
      toolName: COMPLETION_TOOL,
      input: '{"summary":"done"}',
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
  ];
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    }),
  });
  let registeredNames: string[] = [];
  const context: RunContext = {
    runId: "run-offline",
    sessionId: "session-offline",
    messageId: "message-offline",
    provider: "groq",
    model: "llama",
    languageModel: model,
    conversationMode: "ask",
    permissionMode: "auto",
    instructions: { instructions: "BASE", appliedSources: [], skipped: [] },
    request: {
      instructions: "BASE",
      pin: null,
      mentions: [],
      toolSchemas: [],
      messages: [{ id: "user", role: "user", text: "latest" }],
      contextLimit: 128_000,
      sessionMessageCount: 1,
    },
    bind: () => ({
      descriptors: [completion],
      providerTools: {
        authorizeWebSearch: async () => {
          throw new Error("unsupported providers must not ask for search permission");
        },
        descriptorsFor: (providerTools) => {
          registeredNames = providerTools.map((descriptor) => descriptor.name);
          return [...providerTools, completion];
        },
      },
    }),
  };

  await convertReadableStreamToArray(streamRun(context));
  expect(registeredNames).toEqual([]);
  expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).toContain(NO_WEB_SEARCH_SENTENCE);
});

it("maps a provider search error to retryable web_search_failed and completes", async () => {
  const chunks = [
    { type: "stream-start", warnings: [] },
    {
      type: "tool-input-start",
      id: "search-call",
      toolName: "web_search",
      providerExecuted: true,
    },
    { type: "tool-input-end", id: "search-call" },
    {
      type: "tool-call",
      toolCallId: "search-call",
      toolName: "web_search",
      input: "{}",
      providerExecuted: true,
    },
    {
      type: "tool-result",
      toolCallId: "search-call",
      toolName: "web_search",
      result: "search backend unavailable",
      isError: true,
    },
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: "I could not verify that." },
    { type: "text-end", id: "answer" },
    { type: "tool-input-start", id: "complete", toolName: COMPLETION_TOOL },
    { type: "tool-input-delta", id: "complete", delta: '{"summary":"done"}' },
    { type: "tool-input-end", id: "complete" },
    {
      type: "tool-call",
      toolCallId: "complete",
      toolName: COMPLETION_TOOL,
      input: '{"summary":"done"}',
    },
    { type: "finish", finishReason: { unified: "tool-calls", raw: undefined }, usage: usage() },
  ] as StreamPart[];
  const model = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, initialDelayInMs: null, chunkDelayInMs: null }),
    }),
  });
  const search = webSearchToolFor("openai");
  expect(search).not.toBeNull();
  const context: RunContext = {
    runId: "run-error",
    sessionId: "session-error",
    messageId: "message-error",
    provider: "openai",
    model: "gpt-5",
    languageModel: model,
    conversationMode: "ask",
    permissionMode: "auto",
    instructions: { instructions: "BASE", appliedSources: [], skipped: [] },
    request: {
      instructions: "BASE",
      pin: null,
      mentions: [],
      toolSchemas: [],
      messages: [{ id: "user", role: "user", text: "latest" }],
      contextLimit: 128_000,
      sessionMessageCount: 1,
    },
    bind: () => ({
      descriptors: [completion],
      providerTools: {
        authorizeWebSearch: async () => true,
        descriptorsFor: (providerTools) => [...providerTools, completion],
      },
    }),
  };

  const output = await convertReadableStreamToArray(streamRun(context));
  const toolError = output.find((chunk) => chunk.type === "tool-output-error") as
    | (ZocUIChunk & { providerMetadata?: { zoc?: { code?: string; retryable?: boolean } } })
    | undefined;
  expect(toolError?.providerMetadata?.zoc).toMatchObject({
    code: ErrorCode.WEB_SEARCH_FAILED,
    retryable: true,
  });
  const terminal = output.filter((chunk) => chunk.type === "data-zoc-run").at(-1) as
    | Extract<ZocUIChunk, { type: "data-zoc-run" }>
    | undefined;
  expect(terminal?.data.state).toBe("completed");
});
