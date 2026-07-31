/**
 * The provider-failure mapping — zoc-agent-chat-rebuild R7.5, R13.7, R16.6, 9.8.
 *
 * design.md:3630 asks for **every row of the provider-failure mapping table**, so the
 * first block below is exactly that table, row for row, in its order. The blocks after
 * it cover the arms the table does not enumerate but the taxonomy table does — the
 * local-model cases and the content filter — and then the two invariants, which are
 * the assertions that would still matter if every code were renamed.
 */

import { describe, expect, it } from "vitest";
import {
  APICallError,
  InvalidToolInputError,
  LoadAPIKeyError,
  NoSuchModelError,
  NoSuchToolError,
  TypeValidationError,
} from "ai";

import { classifyRunError, createRunErrorClassifier, isAbortFailure } from "../error-taxonomy.ts";
import { DETAILS_LIMIT } from "../../http/errors.ts";

/** An `APICallError` as a provider adapter would build one. */
function apiCall(options: {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
  url?: string;
  message?: string;
  cause?: unknown;
}): APICallError {
  return new APICallError({
    message: options.message ?? "provider call failed",
    url: options.url ?? "https://api.openai.com/v1/chat/completions",
    requestBodyValues: { model: "gpt-4o", messages: [] },
    ...(options.status === undefined ? {} : { statusCode: options.status }),
    ...(options.headers === undefined ? {} : { responseHeaders: options.headers }),
    ...(options.body === undefined ? {} : { responseBody: options.body }),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

function errno(code: string): Error & { code: string } {
  return Object.assign(new Error("connection problem"), { code });
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
}

/** design.md:3581 — the mapping table, as the test's fixture. */
const MAPPING_TABLE: ReadonlyArray<{
  readonly signal: string;
  readonly error: () => unknown;
  readonly code: string;
  readonly retryable: boolean;
}> = [
  {
    signal: "APICallError with 401",
    error: () => apiCall({ status: 401 }),
    code: "provider_auth_failed",
    retryable: false,
  },
  {
    signal: "APICallError with 403",
    error: () => apiCall({ status: 403 }),
    code: "provider_auth_failed",
    retryable: false,
  },
  {
    signal: "APICallError with 429",
    error: () => apiCall({ status: 429 }),
    code: "provider_rate_limited",
    retryable: true,
  },
  {
    signal: "APICallError with Retry-After present",
    error: () => apiCall({ status: 400, headers: { "Retry-After": "30" } }),
    code: "provider_rate_limited",
    retryable: true,
  },
  {
    signal: "APICallError with 5xx",
    error: () => apiCall({ status: 503 }),
    code: "model_unavailable",
    retryable: true,
  },
  {
    signal: "a network error",
    error: () => errno("ECONNRESET"),
    code: "model_unavailable",
    retryable: true,
  },
  {
    signal: "APICallError whose body matches a context-length pattern",
    error: () =>
      apiCall({
        status: 400,
        body: '{"error":{"code":"context_length_exceeded","message":"maximum context length is 8192 tokens"}}',
      }),
    code: "context_window_exceeded",
    retryable: true,
  },
  {
    signal: "NoSuchModelError",
    error: () => new NoSuchModelError({ modelId: "gpt-9", modelType: "languageModel" }),
    code: "model_unavailable",
    retryable: true,
  },
  {
    signal: "InvalidToolInputError",
    error: () =>
      new InvalidToolInputError({ toolName: "workspace_read", toolInput: "{", cause: null }),
    code: "tool_schema_invalid",
    retryable: false,
  },
  {
    signal: "NoSuchToolError",
    error: () => new NoSuchToolError({ toolName: "write_file" }),
    code: "tool_schema_invalid",
    retryable: false,
  },
  {
    signal: "TypeValidationError from Output.object",
    error: () => new TypeValidationError({ value: { files: 3 }, cause: null }),
    code: "plan_invalid",
    retryable: true,
  },
  {
    signal: "AbortError from our own controller",
    error: abortError,
    code: "run_cancelled",
    retryable: false,
  },
  {
    signal: "anything else",
    error: () => new Error("something nobody mapped"),
    code: "internal",
    retryable: false,
  },
];

describe("the provider failure mapping table (design.md:3581)", () => {
  it.each(MAPPING_TABLE)("$signal → $code", ({ error, code, retryable }) => {
    const failure = classifyRunError(error());
    expect(failure.code).toBe(code);
    expect(failure.retryable).toBe(retryable);
  });
});

describe("the context-window arm", () => {
  it("maps llama.cpp's overflow identically to the Gateway, with both numbers", () => {
    // The escaped-JSON shape `model_runtime.py`'s regexes were written against.
    const failure = classifyRunError(
      apiCall({
        status: 500,
        body:
          '{"error":{"type":"exceed_context_size_error",' +
          '"message":"the request exceeds the available context size",' +
          '\\"n_prompt_tokens\\": 9000, \\"n_ctx\\": 8192}}',
      }),
    );

    expect(failure.code).toBe("context_window_exceeded");
    expect(failure.message).toContain("9,000");
    expect(failure.message).toContain("8,192");
    expect(failure.details).toBe("prompt 9000, limit 8192");
  });

  it("still classifies the overflow when no numbers were reported", () => {
    const failure = classifyRunError(
      apiCall({ status: 500, body: "the request exceeds the available context size" }),
    );
    expect(failure.code).toBe("context_window_exceeded");
    expect(failure.message).toContain("too large");
    expect(failure.details).toBeNull();
  });

  it("outranks the status arms, so one failure is one code", () => {
    // OpenAI answers 400 and llama.cpp answers 500 for the same thing. Classifying on
    // status first would split it into `invalid_request` and `model_unavailable`, and
    // neither is the code R12.6's "remove largest attachment" action is bound to.
    for (const status of [400, 500]) {
      expect(
        classifyRunError(apiCall({ status, body: "context window would exceed the limit" })).code,
      ).toBe("context_window_exceeded");
    }
  });

  it("is retryable, because the retry the flag invites is a trimmed one", () => {
    expect(
      classifyRunError(apiCall({ status: 400, body: "context_length_exceeded" })).retryable,
    ).toBe(true);
  });
});

describe("the local-model arms", () => {
  it("tells the user to start the server when nothing is listening on loopback", () => {
    const failure = classifyRunError(
      apiCall({
        url: "http://127.0.0.1:8080/v1/chat/completions",
        cause: errno("ECONNREFUSED"),
      }),
      { provider: "Local (llama.cpp)" },
    );

    expect(failure.code).toBe("local_endpoint_unreachable");
    expect(failure.message).toContain("Start it");
    expect(failure.retryable).toBe(true);
  });

  it("does not claim a cloud provider is a local server the user can start", () => {
    const failure = classifyRunError(
      apiCall({ url: "https://api.openai.com/v1/chat/completions", cause: errno("ECONNREFUSED") }),
      { provider: "OpenAI" },
    );
    expect(failure.code).toBe("model_unavailable");
  });

  it("reports weights still loading as model_not_ready, not as an outage", () => {
    const failure = classifyRunError(
      apiCall({ status: 503, body: '{"error":{"message":"loading model"}}' }),
    );
    expect(failure.code).toBe("model_not_ready");
    expect(failure.retryable).toBe(true);
  });

  it("keeps a plain 503 as an outage", () => {
    expect(classifyRunError(apiCall({ status: 503 })).code).toBe("model_unavailable");
  });
});

describe("the remaining arms", () => {
  it("reports a provider refusal on policy grounds", () => {
    const failure = classifyRunError(
      apiCall({ status: 400, body: '{"error":{"code":"content_filter"}}' }),
      { provider: "Anthropic" },
    );
    expect(failure.code).toBe("provider_content_filtered");
    expect(failure.message).toContain("Anthropic");
    expect(failure.retryable).toBe(false);
  });

  it("reports a missing key as no_key_configured rather than as a rejection", () => {
    // Nothing was rejected: nothing was sent. Telling the user their key was refused
    // sends them to check a key that is not there.
    const failure = classifyRunError(new LoadAPIKeyError({ message: "no key" }), {
      provider: "Groq",
    });
    expect(failure.code).toBe("no_key_configured");
    expect(failure.message).toContain("Groq");
  });

  it("reports an unenumerated 4xx as a rejected request, not as an outage", () => {
    const failure = classifyRunError(apiCall({ status: 422 }), { provider: "xAI (Grok)" });
    expect(failure.code).toBe("invalid_request");
    // The same request will be rejected again, so no retry is offered.
    expect(failure.retryable).toBe(false);
  });

  it("reports a timeout as a retryable outage", () => {
    const failure = classifyRunError(errno("UND_ERR_HEADERS_TIMEOUT"));
    expect(failure.code).toBe("model_unavailable");
    expect(failure.retryable).toBe(true);
  });

  it("finds an abort wrapped two links down a cause chain", () => {
    // `fetch` wraps the abort, so a top-level `name` check reports a cancelled Run as
    // `internal` — a Run the user stopped rendered as a crash.
    const wrapped = new Error("fetch failed", { cause: new Error("x", { cause: abortError() }) });
    expect(isAbortFailure(wrapped)).toBe(true);
    expect(classifyRunError(wrapped).code).toBe("run_cancelled");
  });

  it("treats a cancelled Run's failure as cancellation whatever the error was", () => {
    // A cancel that lands mid-request often surfaces as a socket error a moment later.
    const failure = classifyRunError(apiCall({ status: 500 }), { cancelled: true });
    expect(failure.code).toBe("run_cancelled");
  });
});

describe("the two invariants (R9.8)", () => {
  const bodyWithKey =
    '{"error":{"message":"Incorrect API key provided: sk-live-abcdefghijklmnopqrstuvwxyz012345",' +
    '"param":"/home/user/project/src/secret.ts"}}';

  const everyFailure = [
    ...MAPPING_TABLE.map((row) => classifyRunError(row.error())),
    classifyRunError(apiCall({ status: 401, body: bodyWithKey })),
    classifyRunError(apiCall({ status: 500, body: bodyWithKey })),
    classifyRunError(apiCall({ status: 422, body: bodyWithKey })),
    classifyRunError(apiCall({ status: 400, body: `${bodyWithKey} context_length_exceeded` })),
  ];

  it("never puts a provider body, a key, or a path in message or details", () => {
    for (const failure of everyFailure) {
      const rendered = `${failure.message} ${failure.details ?? ""}`;
      expect(rendered).not.toContain("sk-live-");
      expect(rendered).not.toContain("/home/user/project");
      expect(rendered).not.toContain("Incorrect API key provided");
    }
  });

  it("never puts a type name in the sentence the user reads", () => {
    for (const failure of everyFailure) {
      expect(failure.message).not.toMatch(/AI_[A-Za-z]*Error|Error:|\bundefined\b/);
    }
  });

  it("writes a sentence, ending in a full stop", () => {
    for (const failure of everyFailure) {
      expect(failure.message.length).toBeGreaterThan(8);
      expect(failure.message.trimEnd().endsWith(".")).toBe(true);
    }
  });

  it("bounds details to 600 characters", () => {
    const huge = "x".repeat(40_000);
    const failure = classifyRunError(apiCall({ status: 500, body: huge }));
    expect(failure.details?.length ?? 0).toBeLessThanOrEqual(DETAILS_LIMIT);
    // And it is not the body at all, bounded or otherwise.
    expect(failure.details).not.toContain("xxxx");
  });
});

describe("createRunErrorClassifier", () => {
  it("binds the provider label the surface's card needs (R13.7)", () => {
    const classify = createRunErrorClassifier({ provider: "OpenAI", model: "gpt-4o" });
    expect(classify(apiCall({ status: 401 })).message).toContain("OpenAI");
  });

  it("falls back to a neutral subject when no label was bound", () => {
    expect(classifyRunError(apiCall({ status: 401 })).message).toContain("The model provider");
  });

  it("ignores a blank label rather than writing an empty subject", () => {
    const classify = createRunErrorClassifier({ provider: "   " });
    expect(classify(apiCall({ status: 429 })).message).toContain("The model provider");
  });
});
