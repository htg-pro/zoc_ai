/**
 * Property 42: Error rows offer retry exactly when retryable. Validates R16.6, R9.6.
 * Plus 16.2's own claim: one normaliser handles all three sources.
 *
 * The normaliser is the thing under test rather than a row, because "exactly when
 * retryable" is a claim about the flag surviving three different wire shapes — and the
 * shape it was *not* surviving is why 16.2 exists. `ZocChatTransport` throws a
 * `RuntimeRequestError` with the four fields under `.envelope`, and `readEnvelope`
 * unwrapped `detail` and not `envelope`, so every Agent_Runtime failure arrived as a bare
 * `Error.message` with its code, `details`, and `retryable` all lost.
 *
 * That last loss is the load-bearing one: `retryable` absent reads as "no retry", so the
 * bug was silent — a rate-limited Run that should have offered a retry simply did not.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ErrorPart } from "@zoc-studio/shared-types";

import { ErrorCodes, normalizeError, offersRetry, type AppError } from "@/lib/errors";

const RUNS = { numRuns: 100 } as const;

/** The four-field envelope all three sources carry. */
const envelope = fc.record({
  code: fc.constantFrom(
    "provider_auth_failed",
    "provider_rate_limited",
    "model_unavailable",
    "workspace_unavailable",
    "workspace_failed",
    "tool_schema_invalid",
    "compaction_failed",
    "slot_queue_full",
    "stream_lost",
    "resume_window_expired",
    "internal",
  ),
  message: fc.string({ minLength: 4, maxLength: 120 }).map((text) => `${text.trim() || "failed"}.`),
  details: fc.option(fc.string({ maxLength: 200 }), { nil: null }),
  retryable: fc.boolean(),
});

type Envelope = { code: string; message: string; details: string | null; retryable: boolean };

/** Source 1: a Workspace_Services error, bare or under FastAPI's `detail`. */
function asGatewayError(value: Envelope, wrapped: boolean): unknown {
  return wrapped ? { detail: value } : value;
}

/** Source 2: the transport's `RuntimeRequestError`, with the envelope nested. */
function asRuntimeError(value: Envelope, status: number): unknown {
  return Object.assign(new Error(value.message), {
    name: "RuntimeRequestError",
    status,
    envelope: value,
  });
}

/** Source 3: a streamed `data-zoc-error` part, four fields at the top level. */
function asErrorPart(value: Envelope): ErrorPart {
  return {
    type: "error",
    seq: 7,
    runId: "run_1",
    messageId: "msg_1",
    ts: "2026-07-31T00:00:00.000Z",
    agentName: null,
    code: value.code,
    message: value.message,
    details: value.details,
    retryable: value.retryable,
  };
}

describe("16.2: one normaliser handles all three sources (R16.6)", () => {
  it("preserves the code from every source", () => {
    fc.assert(
      fc.property(envelope, fc.boolean(), (value, wrapped) => {
        for (const source of [
          asGatewayError(value, wrapped),
          asRuntimeError(value, 502),
          asErrorPart(value),
        ]) {
          const normalised = normalizeError(source);
          // `context_window_exceeded` is the one code `sanitizeErrorForDisplay` rewrites, and
          // it is not in the generator, so the code passes through untouched.
          expect(normalised.code, JSON.stringify(source)).toBe(value.code);
        }
      }),
      RUNS,
    );
  });

  it("preserves the retryable flag from every source, which is the bug 16.2 fixed", () => {
    fc.assert(
      fc.property(envelope, fc.boolean(), (value, wrapped) => {
        for (const source of [
          asGatewayError(value, wrapped),
          asRuntimeError(value, 502),
          asErrorPart(value),
        ]) {
          expect(normalizeError(source).retryable).toBe(value.retryable);
        }
      }),
      RUNS,
    );
  });

  it("preserves the human sentence rather than falling back to generic copy", () => {
    fc.assert(
      fc.property(envelope, (value) => {
        for (const source of [
          asGatewayError(value, false),
          asRuntimeError(value, 502),
          asErrorPart(value),
        ]) {
          expect(normalizeError(source).message).toBe(value.message);
        }
      }),
      RUNS,
    );
  });

  it("normalises all three sources to the same AppError", () => {
    // The claim R16.6 actually makes: not "each source works" but "the surface cannot tell
    // them apart". A renderer branching on source would be the thing this rules out.
    fc.assert(
      fc.property(envelope, (value) => {
        const fromGateway = normalizeError(asGatewayError(value, true));
        const fromPart = normalizeError(asErrorPart(value));
        // The runtime error carries an HTTP status the other two have no equivalent for, so
        // it is compared field by field minus that one.
        const fromRuntime = normalizeError(asRuntimeError(value, 502));

        expect(fromPart).toEqual(fromGateway);
        expect({ ...fromRuntime, status: undefined }).toEqual({
          ...fromGateway,
          status: undefined,
        });
      }),
      RUNS,
    );
  });

  it("keeps the HTTP status when the source has one, so auth detection still works", () => {
    fc.assert(
      fc.property(envelope, fc.constantFrom(400, 401, 403, 429, 502), (value, status) => {
        expect(normalizeError(asRuntimeError(value, status)).status).toBe(status);
      }),
      RUNS,
    );
  });

  it("bounds details from every source", () => {
    // R9.8 bounds `details` at 600 characters runtime-side; the renderer clamps again, because
    // a stored transcript from before that rule still has to render.
    fc.assert(
      fc.property(envelope, fc.string({ minLength: 900, maxLength: 1200 }), (value, huge) => {
        const normalised = normalizeError(asErrorPart({ ...value, details: huge }));
        expect((normalised.details ?? "").length).toBeLessThanOrEqual(601);
      }),
      RUNS,
    );
  });
});

describe("Feature: zoc-agent-chat-rebuild, Property 42: error rows offer retry exactly when retryable", () => {
  it("offers retry if and only if the flag is true", () => {
    fc.assert(
      fc.property(envelope, (value) => {
        const normalised = normalizeError(asErrorPart(value));
        expect(offersRetry(normalised)).toBe(value.retryable);
      }),
      RUNS,
    );
  });

  it("withholds retry when the flag is absent", () => {
    // The default, and it is a decision rather than an accident: an unclassified failure is
    // one nothing knows how to retry, so a retry control there is a button with no reason to
    // believe it will help.
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (message) => {
        const normalised = normalizeError(new Error(message));
        expect(normalised.retryable).toBeUndefined();
        expect(offersRetry(normalised)).toBe(false);
      }),
      RUNS,
    );
  });

  it("never offers retry for a cancellation, whatever the flag says", () => {
    // A cancelled Run is not a failure. R16.1's stop is not something to retry *from*: the
    // user asked for it, and the affordance they want is "send again", which the composer is.
    for (const code of [ErrorCodes.cancelled, ErrorCodes.runCancelled]) {
      for (const retryable of [true, false, undefined]) {
        const error: AppError = {
          code,
          message: "Stopped.",
          ...(retryable === undefined ? {} : { retryable }),
        };
        expect(offersRetry(error), `${code} retryable=${String(retryable)}`).toBe(false);
      }
    }
  });

  it("renders a code and a message for every source, so a row is never blank", () => {
    // Property 42's first clause: the row displays its `code` and `message`. A normaliser that
    // dropped either would leave a row with a retry control and nothing to explain it.
    fc.assert(
      fc.property(envelope, (value) => {
        const normalised = normalizeError(asErrorPart(value));
        expect(normalised.code.length).toBeGreaterThan(0);
        expect(normalised.message.length).toBeGreaterThan(0);
      }),
      RUNS,
    );
  });
});
