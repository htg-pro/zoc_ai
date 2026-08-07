/**
 * Property 35 (the error half) and Property 42's precondition — R9.8, R14.10, R16.6.
 *
 * Feature: zoc-agent-chat-rebuild, Property 35 (R9.8, R14.10, R16.6).
 *
 * Two claims, both about arbitrary inputs rather than about the fixtures the
 * table-driven test uses:
 *
 *   - **No key value reaches an error record.** A provider error body routinely quotes
 *     the request it rejected, and the request carried the key — so the interesting
 *     input is not a well-formed body but an arbitrary one with a secret embedded
 *     anywhere in it. The classifier reads bodies to match patterns against and must
 *     forward none of them.
 *   - **Every classification is a complete envelope.** Property 42 renders a retry
 *     control if and only if `retryable` is true, which is only meaningful if all four
 *     fields are always populated with the right *types* — a `retryable` that came
 *     back `undefined` for one arm would render no control and look correct.
 */

import { describe, it } from "vitest";
import fc from "fast-check";
import { APICallError } from "ai";

import { classifyRunError } from "../error-taxonomy.ts";
import { DETAILS_LIMIT } from "../../http/errors.ts";

const RUNS = { numRuns: 300 } as const;

/** Key shapes worth planting: the prefixed ones and an opaque run. */
const secret = fc.oneof(
  fc.string({ minLength: 8, maxLength: 24 }).map((tail) => `sk-live-${tail}`),
  fc.string({ minLength: 8, maxLength: 24 }).map((tail) => `sk-ant-api03-${tail}`),
  fc.string({ minLength: 8, maxLength: 24 }).map((tail) => `gsk_${tail}`),
  fc.string({ minLength: 32, maxLength: 64 }),
);

const status = fc.oneof(
  fc.constantFrom(400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504),
  fc.constant(undefined),
);

/** Fragments that steer the classifier down each of its arms. */
const steer = fc.constantFrom(
  "",
  "exceed_context_size_error",
  "exceeds the available context size",
  "context_length_exceeded",
  "maximum context length is 8192 tokens",
  '\\"n_prompt_tokens\\": 9000, \\"n_ctx\\": 8192',
  "loading model",
  "content_filter",
  "refusal",
);

describe("Property 35 (error half): no key value reaches an error record", () => {
  it("forwards no planted secret from a provider body, message, or data", () => {
    fc.assert(
      fc.property(
        secret,
        status,
        steer,
        fc.string({ maxLength: 200 }),
        (key, code, fragment, noise) => {
          const error = new APICallError({
            // Planted in all three places a provider adapter can put text.
            message: `request failed for key ${key} ${fragment}`,
            url: "https://api.openai.com/v1/chat/completions",
            requestBodyValues: { apiKey: key },
            ...(code === undefined ? {} : { statusCode: code }),
            responseBody: `{"error":{"message":"${noise} ${key}","hint":"${fragment}"}}`,
            responseHeaders: { authorization: `Bearer ${key}` },
            data: { echoed: key },
          });

          const failure = classifyRunError(error, { provider: "OpenAI", model: "gpt-4o" });
          const rendered = `${failure.message}\n${failure.details ?? ""}`;
          return !rendered.includes(key);
        },
      ),
      RUNS,
    );
  });

  it("forwards nothing from an arbitrary thrown value either", () => {
    fc.assert(
      fc.property(secret, (key) => {
        const failure = classifyRunError(new Error(`boom ${key}`));
        const rendered = `${failure.message}\n${failure.details ?? ""}`;
        return !rendered.includes(key);
      }),
      RUNS,
    );
  });
});

describe("Property 42's precondition: every classification is a complete envelope", () => {
  /** Any failure the runtime can plausibly be handed, already constructed. */
  const anyError: fc.Arbitrary<unknown> = fc.oneof(
    fc.tuple(status, steer, fc.string({ maxLength: 120 })).map(
      ([code, fragment, text]) =>
        new APICallError({
          message: text,
          // Loopback, so the local arms are reachable too.
          url: "http://127.0.0.1:8080/v1/chat/completions",
          requestBodyValues: {},
          ...(code === undefined ? {} : { statusCode: code }),
          responseBody: `${fragment} ${text}`,
        }),
    ),
    fc.string({ maxLength: 24 }).map((code) => Object.assign(new Error("connection"), { code })),
    fc.string({ maxLength: 120 }).map((text) => new Error(text)),
    fc.anything(),
  );

  it("populates all four fields with the right types, for every arm", () => {
    fc.assert(
      fc.property(anyError, (error) => {
        const failure = classifyRunError(error);
        return (
          typeof failure.code === "string" &&
          failure.code.length > 0 &&
          typeof failure.message === "string" &&
          failure.message.length > 0 &&
          typeof failure.retryable === "boolean" &&
          (failure.details === null ||
            (typeof failure.details === "string" &&
              failure.details.length > 0 &&
              failure.details.length <= DETAILS_LIMIT))
        );
      }),
      RUNS,
    );
  });

  it("never reports a retryable failure with an empty sentence", () => {
    // Property 42 renders the row's `message` next to the retry control, so a retryable
    // failure with nothing to read is a button with no explanation beside it.
    fc.assert(
      fc.property(status, steer, (code, fragment) => {
        const failure = classifyRunError(
          new APICallError({
            message: "",
            url: "https://api.groq.com/openai/v1/chat/completions",
            requestBodyValues: {},
            ...(code === undefined ? {} : { statusCode: code }),
            responseBody: fragment,
          }),
        );
        return failure.message.trim().length > 8;
      }),
      RUNS,
    );
  });
});
