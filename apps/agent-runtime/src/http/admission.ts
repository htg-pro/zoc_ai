/**
 * Agent_Runtime admission — zoc-agent-chat-rebuild R3.4, R3.5, R3.6.
 *
 * Two independent checks, in a deliberate order:
 *
 *   1. The peer must be loopback. Checked *first*, before the credential is
 *      even read off the headers, so a remote probe cannot use response timing
 *      to learn anything about the token — not its length, not a prefix.
 *   2. The presented bearer must equal the per-launch token, compared in
 *      constant time. The token is a bearer capability, so a timing oracle
 *      against a co-resident process is a real threat on a shared machine.
 *
 * `/health` is the single exception and it is enumerated here rather than
 * decided at the call site: Desktop_Core's supervisor poll runs before the
 * token has been distributed, and a liveness probe leaks nothing.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { ErrorCode, envelope, type ErrorEnvelope } from "./errors.ts";

/** Peers the runtime will speak to at all (R3.6). */
export const LOOPBACK_PEERS: ReadonlySet<string> = new Set([
  "127.0.0.1",
  "::1",
  "::ffff:127.0.0.1",
]);

/** Routes reachable by any loopback caller with no credential (R3.5). */
export const UNAUTHENTICATED_PATHS: ReadonlySet<string> = new Set(["/health"]);

export type AdmitFailureCode =
  | typeof ErrorCode.REMOTE_REFUSED
  | typeof ErrorCode.UNAUTHORIZED;

export type AdmitResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 403 | 401; readonly code: AdmitFailureCode };

const ADMITTED: AdmitResult = Object.freeze({ ok: true as const });

/**
 * The two sentences a refused caller is allowed to read.
 *
 * They live here, beside the decision that produces them, rather than at the
 * writing call site, because a refusal body is part of the boundary: it must
 * carry no run id, no path, no credential, and no hint about the token's length
 * or shape. Fixed strings with `details: null` is the only version of that which
 * cannot drift — there is no interpolation to review.
 */
export function refusalEnvelope(code: AdmitFailureCode): ErrorEnvelope {
  return envelope(
    code,
    code === ErrorCode.REMOTE_REFUSED
      ? "This service accepts local connections only."
      : "This request was not authorised.",
    { retryable: false },
  );
}

/**
 * Compare two strings without leaking their contents through timing.
 *
 * `timingSafeEqual` throws when the buffers differ in length, which would
 * itself be a length oracle. Hashing both sides to a fixed width first removes
 * the length signal entirely, at the cost of one SHA-256 per request — which is
 * nothing next to a provider call.
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/** Strip the `Bearer ` prefix, returning `""` for any other scheme. */
export function presentedToken(req: Pick<IncomingMessage, "headers">): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/**
 * The request path with the query string removed — and nothing else.
 *
 * Deliberately *not* normalised. The router resolves `..` and empty segments
 * through `new URL()`, so a crafted target like `/v1/../health` reaches the
 * health handler while this function still reports `/v1/../health`, which is not
 * in `UNAUTHENTICATED_PATHS` and therefore still needs the token. Every
 * disagreement between the two readings lands on the closed side: the only path
 * this admits without a credential is the literal `/health`, which is also the
 * only thing Desktop_Core's supervisor and the renderer's readiness probe send.
 */
export function requestPath(url: string | undefined): string {
  const raw = url ?? "/";
  const q = raw.indexOf("?");
  return q === -1 ? raw : raw.slice(0, q);
}

export function isLoopbackPeer(peer: string | undefined): boolean {
  return LOOPBACK_PEERS.has(peer ?? "");
}

export interface AdmissionConfig {
  /** The per-launch token Desktop_Core generated and passed in the env. */
  readonly token: string;
}

/**
 * Build the admission check for one runtime launch.
 *
 * The token is captured in the closure rather than read from `process.env` on
 * every request, so a later `delete process.env.ZOC_RUNTIME_TOKEN` (which
 * `main.ts` performs immediately after boot) cannot turn admission off.
 */
export function createAdmission(config: AdmissionConfig) {
  const { token } = config;
  if (token.length === 0) {
    throw new Error(
      "Agent_Runtime refuses to start without a launch token: an unauthenticated " +
        "runtime would expose the workspace to any loopback process.",
    );
  }

  return function admit(
    req: Pick<IncomingMessage, "headers" | "url"> & { socket?: { remoteAddress?: string } },
  ): AdmitResult {
    // R3.6 first — see the module comment for why the order is load-bearing.
    // A request with no socket to read a peer from is refused rather than
    // waved through: the unknown case belongs on the closed side.
    if (!isLoopbackPeer(req.socket?.remoteAddress)) {
      return { ok: false, status: 403, code: ErrorCode.REMOTE_REFUSED };
    }

    if (UNAUTHENTICATED_PATHS.has(requestPath(req.url))) {
      return ADMITTED;
    }

    if (!timingSafeEqualStr(presentedToken(req), token)) {
      return { ok: false, status: 401, code: ErrorCode.UNAUTHORIZED };
    }

    return ADMITTED;
  };
}

export type Admit = ReturnType<typeof createAdmission>;
