/**
 * Agent_Runtime request validation gate — zoc-agent-chat-rebuild R7.5.
 *
 * Every `/v1/*` body passes through one `zod` schema and one converter. A
 * schema failure becomes HTTP 422 with all four envelope fields populated —
 * `code`, `message`, `details`, `retryable` — because a caller that receives a
 * 422 with a bare string has to guess whether retrying is pointless.
 *
 * The `message` carries no run id, no path, and no credential, and neither does
 * `details`. That guarantee is structural rather than conventional, because the
 * obvious implementation leaks:
 *
 *   - **Every `zod@4` issue carries the offending input.** `$ZodIssueBase` has
 *     an `input?: unknown` field, so anything that spreads or stringifies an
 *     issue puts the rejected body straight into the response. This module
 *     reads a whitelist of fields off each issue and never the issue itself.
 *   - **`issue.message` can embed the input too.** `unrecognized_keys` renders
 *     `Unrecognized key: "<the key>"`, and a schema author's own `error`
 *     callback may interpolate `iss.input`. So the expectation text is derived
 *     from the issue's *structured* fields — the declared type, the declared
 *     bound, the declared literal set — and `issue.message` is never used.
 *   - **A field path can be input-derived.** `z.record()` keys land in
 *     `issue.path`, so a body keyed by a credential puts that credential in the
 *     path. Every segment is therefore checked against the wire's own field-name
 *     shape and against a credential shape, and anything else is redacted.
 *
 * The division of labour: `message` is the human sentence and names nothing at
 * all; `details` carries the per-field specifics, which is what lets the surface
 * render the design's "card naming the rejected field" treatment.
 */

import type { ZodType } from "zod";
import { ErrorCode, HttpError, boundDetails, envelope } from "./errors.ts";

/** Stand-in for a path segment that could have come from the request. */
export const REDACTED = "[redacted]";

/** Maximum number of individual field issues named in `details`. */
const MAX_ISSUES = 8;

/** Maximum number of schema-declared literals rendered for one issue. */
const MAX_DECLARED_VALUES = 6;

/** Longest path segment treated as a field name rather than as input. */
const MAX_SEGMENT_CHARS = 32;

/** Longest schema-declared string literal rendered in full. */
const MAX_LITERAL_CHARS = 24;

/** Longest subject noun accepted into the message sentence. */
const MAX_SUBJECT_CHARS = 40;

/**
 * The wire protocol's field-name shape: camelCase or snake_case, no separators
 * beyond `_`. A declared field always matches; a record key drawn from a request
 * body usually does not, which is what makes this a useful filter.
 */
const WIRE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Credential shapes, matched against a path segment or a declared literal.
 *
 * The list is prefix-led because provider keys are prefix-tagged, and it ends
 * with a length rule that catches the opaque ones that are not. It is a filter
 * on what may be *echoed*, not a secret detector: everything that fails the
 * field-name shape above is already redacted, so this only has to catch the
 * strings that look like plausible identifiers and are not.
 */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /^(?:sk|pk|rk|ak)[-_]/i, // OpenAI, Anthropic, Stripe-style
  /^(?:gh[pousr]_|github_pat_)/, // GitHub
  /^(?:xox[baprs]-|xapp-)/, // Slack
  /^(?:AKIA|ASIA)[0-9A-Z]{8,}/, // AWS access key id
  /^AIza[0-9A-Za-z_-]{10,}/, // Google
  /^(?:gsk|hf|xai)[-_]/i, // Groq, Hugging Face, xAI
  /^ey[A-Za-z0-9_-]{8,}\./, // JWT
  /^(?:bearer|basic)\s/i, // an Authorization header value
  /[A-Za-z0-9_-]{32,}/, // any opaque 32+ character run
];

function looksLikeCredential(text: string): boolean {
  return CREDENTIAL_SHAPES.some((shape) => shape.test(text));
}

export interface ValidationIssue {
  /** Dotted field path, e.g. `messages.0.role`. Never a value. */
  readonly path: string;
  /** `zod`'s own issue code, e.g. `invalid_type`. */
  readonly code: string;
  /** What the schema expected, derived from the schema. Never the input. */
  readonly expected: string;
}

/**
 * The subset of a `zod` issue this module is willing to read.
 *
 * Deliberately structural rather than `z.core.$ZodIssue`: the type it omits is
 * the point. `input` and `params` are absent here so no code path in this file
 * can reach them, and `message` is absent so none can echo it.
 */
interface ZodLikeIssue {
  readonly path?: ReadonlyArray<string | number | symbol>;
  readonly code?: string;
  /** `invalid_type` — the declared type name. */
  readonly expected?: unknown;
  /** `invalid_value` — the declared literal set. */
  readonly values?: ReadonlyArray<unknown>;
  /** `unrecognized_keys` — input-derived, so only its length is ever read. */
  readonly keys?: ReadonlyArray<unknown>;
  /** `too_big` / `too_small` — the declared bound and what it bounds. */
  readonly origin?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly inclusive?: boolean;
  /** `invalid_format` — the declared format name. */
  readonly format?: unknown;
  /** `not_multiple_of` — the declared divisor. */
  readonly divisor?: unknown;
}

/** Keep a segment only if it looks like a declared field name. */
function scrubSegment(segment: string): string {
  if (segment.length === 0 || segment.length > MAX_SEGMENT_CHARS) return REDACTED;
  if (!WIRE_FIELD_NAME.test(segment)) return REDACTED;
  if (looksLikeCredential(segment)) return REDACTED;
  return segment;
}

function renderSegment(segment: string | number | symbol): string {
  if (typeof segment === "number") return String(segment);
  if (typeof segment === "symbol") return REDACTED;
  return scrubSegment(segment);
}

function renderPath(path: ReadonlyArray<string | number | symbol> | undefined): string {
  if (!path || path.length === 0) return "(root)";
  return path.map(renderSegment).join(".");
}

/** Render a schema-declared literal, redacting one that is itself a secret. */
function renderLiteral(value: unknown): string {
  if (typeof value === "string") {
    if (looksLikeCredential(value)) return REDACTED;
    const clipped =
      value.length > MAX_LITERAL_CHARS ? `${value.slice(0, MAX_LITERAL_CHARS - 1)}…` : value;
    return JSON.stringify(clipped);
  }
  if (typeof value === "symbol") return REDACTED;
  return String(value);
}

function renderBound(bound: unknown, origin: unknown): string {
  const amount = typeof bound === "bigint" ? bound.toString() : String(bound);
  switch (origin) {
    case "string":
      return `${amount} characters`;
    case "array":
    case "set":
    case "file":
      return `${amount} items`;
    default:
      return amount;
  }
}

/**
 * Describe what the schema wanted, using only what the schema declared.
 *
 * The `default` arm is what makes this total: a `zod` release that adds an issue
 * code produces a vague sentence rather than falling through to `issue.message`
 * and leaking whatever that release decided to interpolate.
 */
function describeExpectation(issue: ZodLikeIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return typeof issue.expected === "string"
        ? `expected ${issue.expected}`
        : "expected a value of the declared type";

    case "invalid_value": {
      const values = issue.values ?? [];
      if (values.length === 0) return "expected one of the declared values";
      const shown = values.slice(0, MAX_DECLARED_VALUES).map(renderLiteral).join(", ");
      const elided = values.length - Math.min(values.length, MAX_DECLARED_VALUES);
      return elided > 0 ? `expected one of ${shown} (+${elided} more)` : `expected one of ${shown}`;
    }

    case "too_big":
      return issue.maximum === undefined
        ? "expected a smaller value"
        : `expected at most ${renderBound(issue.maximum, issue.origin)}`;

    case "too_small":
      return issue.minimum === undefined
        ? "expected a larger value"
        : `expected at least ${renderBound(issue.minimum, issue.origin)}`;

    case "invalid_format":
      return typeof issue.format === "string"
        ? `expected format ${issue.format}`
        : "expected the declared format";

    case "not_multiple_of":
      return issue.divisor === undefined
        ? "expected a multiple of the declared divisor"
        : `expected a multiple of ${String(issue.divisor)}`;

    // The key names are the request's, not the schema's, so only the count is
    // reported — a body keyed by a credential is the realistic leak here.
    case "unrecognized_keys": {
      const count = issue.keys?.length ?? 0;
      return count === 1 ? "1 unrecognized key" : `${count} unrecognized keys`;
    }

    case "invalid_union":
      return "matched none of the allowed shapes";
    case "invalid_key":
      return "carries a key of the wrong shape";
    case "invalid_element":
      return "carries an element of the wrong shape";
    case "custom":
      return "failed a declared constraint";
    default:
      return "did not satisfy the schema";
  }
}

/** Project `zod` issues into value-free, schema-derived issues. */
export function projectIssues(issues: ReadonlyArray<ZodLikeIssue>): ValidationIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => ({
    path: renderPath(issue.path),
    code: issue.code ?? "invalid",
    expected: describeExpectation(issue),
  }));
}

function describe(issues: ReadonlyArray<ValidationIssue>, total: number): string {
  const rendered = issues.map((i) => `${i.path}: ${i.expected}`).join("; ");
  const elided = total - issues.length;
  return elided > 0 ? `${rendered}; and ${elided} more` : rendered;
}

/** A plain noun phrase: letters and single spaces, nothing else. */
const SUBJECT_SHAPE = new RegExp(`^[A-Za-z][A-Za-z ]{0,${MAX_SUBJECT_CHARS - 1}}$`);

/**
 * Accept the caller's subject noun, or fall back to a constant.
 *
 * Call sites pass a static phrase ("run request"), so this changes nothing in
 * practice — it is here so the sentence's freedom from run ids, paths, and
 * credentials is a property of this function rather than a habit of every
 * handler.
 *
 * Rejecting rather than repairing: filtering a hostile subject down to its
 * letters would keep the words, and the words of a path are most of the path.
 * A subject carrying a digit, a separator, or a slash is not salvaged at all.
 */
function scrubSubject(what: string): string {
  const phrase = what.trim().replace(/\s+/g, " ");
  if (!SUBJECT_SHAPE.test(phrase)) return "request";
  if (looksLikeCredential(phrase)) return "request";
  return phrase;
}

/**
 * Validate `body` against `schema`, throwing a fully-populated 422 on failure.
 *
 * `retryable` is `false`: a body the schema rejects will be rejected again
 * unchanged, so telling the caller to retry would be a lie.
 */
export function validate<T>(schema: ZodType<T>, body: unknown, what: string): T {
  const result = schema.safeParse(body);
  if (result.success) return result.data;

  const raw = (result.error as { issues?: ReadonlyArray<ZodLikeIssue> }).issues ?? [];
  const issues = projectIssues(raw);
  throw new HttpError(
    422,
    envelope(
      ErrorCode.INVALID_REQUEST,
      `The ${scrubSubject(what)} was not in the expected shape.`,
      {
        details: describe(issues, raw.length),
        retryable: false,
      },
    ),
  );
}

/**
 * Read and JSON-parse a request body with a hard size ceiling.
 *
 * The ceiling is enforced while reading rather than after, so an oversized body
 * cannot be buffered in full before being rejected.
 */
export async function readJsonBody(
  stream: AsyncIterable<Uint8Array>,
  limitBytes = 4 * 1024 * 1024,
): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > limitBytes) {
      throw new HttpError(
        413,
        envelope(ErrorCode.INVALID_REQUEST, "The request body was too large.", {
          details: `limit ${limitBytes} bytes`,
        }),
      );
    }
    chunks.push(chunk);
  }
  if (size === 0) return undefined;

  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    // The parser's own message is positional ("Unexpected token } in JSON at
    // position 41") rather than a quotation of the body, so it is safe to pass
    // through — but it goes through the same credential filter regardless,
    // because "safe today" is not a guarantee about the next Node release.
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new HttpError(
      422,
      envelope(ErrorCode.INVALID_REQUEST, "The request body was not valid JSON.", {
        details: boundDetails(looksLikeCredential(reason) ? REDACTED : reason),
        retryable: false,
      }),
    );
  }
}
