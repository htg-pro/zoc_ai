/**
 * Admission properties — zoc-agent-chat-rebuild.
 *
 * Property 10: Only the launch token is admitted    (validates R3.4, R3.5)
 * Property 11: Only loopback peers are admitted     (validates R3.6)
 *
 * Both run at 200 iterations rather than the default 100. Admission is the
 * runtime's only trust boundary: everything behind it can read provider keys
 * and write the workspace, so a hole here is not a degraded feature, it is the
 * whole guarantee.
 *
 * Property 10 asserts the *decision*, not the response. The 401 body over a real
 * socket is `handshake.integration.test.ts`'s claim (task 3.4); driving a server
 * 200 times per case would buy nothing here and would make a pure predicate's
 * property depend on socket setup.
 *
 * The wrong-credential generator is deliberately not `fc.string()`. Random short
 * strings only ever exercise the far-miss case — they differ from the token in
 * length, alphabet, and every byte at once — so a comparison that trimmed
 * whitespace, folded case, or read only a prefix would satisfy them all. The
 * `nearMiss` family below draws the credentials an attacker actually holds: the
 * token minus its last byte, the token with one byte changed, the token with a
 * trailing space, the same token in the wrong case. Those are the draws that make
 * "byte-identical" mean byte-identical.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createConnection, createServer } from "node:net";
import type { IncomingHttpHeaders } from "node:http";

import {
  LOOPBACK_PEERS,
  UNAUTHENTICATED_PATHS,
  createAdmission,
  isLoopbackPeer,
  presentedToken,
  refusalEnvelope,
  requestPath,
  timingSafeEqualStr,
} from "../admission.ts";

const RUNS = { numRuns: 200 } as const;

const LAUNCH_TOKEN = "cQ8mZ1v6yR4tN0pL7bK3jX5hW2sD9gF-aE_uI4oY6cM";

const loopbackPeer = fc.constantFrom(...LOOPBACK_PEERS);

// Property 11's peer generators are declared beside Property 11, below, because
// the adversarial family needs its own paragraph of reasoning and nothing in
// Property 10 draws from it.

/** A path that requires the token. */
const guardedPath = fc
  .oneof(
    fc.constantFrom(
      "/v1/runs",
      "/v1/runs/run_1/stream",
      "/v1/runs/run_1/cancel",
      "/v1/providers",
      "/v1/models",
      "/v1/tools",
      "/v1/permissions/audit",
      "/v1/inline-edit",
      "/v1/completions",
    ),
    fc
      .array(fc.hexaString({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 })
      .map((segments) => `/v1/${segments.join("/")}`),
  )
  .filter((p) => !UNAUTHENTICATED_PATHS.has(requestPath(p)));

/** Base64url — the alphabet Desktop_Core's 32-CSPRNG-byte token is encoded in. */
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * An arbitrary launch token.
 *
 * Generating the token as well as the credential is what turns "this one 43-byte
 * string is compared correctly" into "any launch token is". A comparison that
 * happened to work for the fixed constant — because of its length, or because of
 * where its first `-` falls — has nowhere to hide.
 */
const launchToken = fc
  .array(fc.integer({ min: 0, max: BASE64URL.length - 1 }), {
    minLength: 32,
    maxLength: 64,
  })
  .map((codes) => codes.map((i) => BASE64URL[i]).join(""));

function replaceAt(token: string, index: number, code: number): string {
  return `${token.slice(0, index)}${String.fromCharCode(code)}${token.slice(index + 1)}`;
}

/** Rotate within printable ASCII (33–126, 94 wide); a non-zero shift always moves. */
function shiftPrintable(code: number, shift: number): number {
  return 33 + ((((code - 33) % 94) + 94 + shift) % 94);
}

function flipCase(code: number): number {
  if (code >= 65 && code <= 90) return code + 32;
  if (code >= 97 && code <= 122) return code - 32;
  return code;
}

/**
 * The credential classes that sit one edit away from `token`.
 *
 * Returned as a flat list rather than a single `oneof` so a caller can splice it
 * into a wider `oneof` and have every class drawn at the same weight — folded
 * into one nested branch, the near misses would collectively get half the draws
 * of the single unrelated-string branch they are meant to outnumber.
 *
 * Each entry names the weakening it catches:
 */
function nearMissFamily(token: string): fc.Arbitrary<string>[] {
  const letterIndices = [...token].flatMap((c, i) => (/[A-Za-z]/.test(c) ? [i] : []));

  const family: fc.Arbitrary<string>[] = [
    // No credential at all, presented as an empty bearer value.
    fc.constant(""),
    // Catches a comparison that trims. `Bearer ${token} ` is what a copy-paste
    // out of a log or a JSON blob actually produces.
    fc.constantFrom(`${token} `, ` ${token}`, `${token}\t`, `${token}\r\n`, `\n${token}`),
    // Catches a prefix-only compare, including the one-byte-short case.
    fc.integer({ min: 0, max: token.length - 1 }).map((n) => token.slice(0, n)),
    // Catches a suffix-only or `endsWith` compare.
    fc.integer({ min: 1, max: token.length }).map((n) => token.slice(n)),
    // Same length, exactly one byte different: the case a length check, a hash
    // prefix, or a truncated compare all wave through.
    fc
      .tuple(fc.integer({ min: 0, max: token.length - 1 }), fc.integer({ min: 1, max: 93 }))
      .map(([index, shift]) =>
        replaceAt(token, index, shiftPrintable(token.charCodeAt(index), shift)),
      ),
    // One byte longer — the token with a stray character spliced in.
    fc
      .tuple(fc.integer({ min: 0, max: token.length }), fc.integer({ min: 33, max: 126 }))
      .map(
        ([index, code]) =>
          `${token.slice(0, index)}${String.fromCharCode(code)}${token.slice(index)}`,
      ),
    // One byte shorter, cut from the middle rather than the end.
    fc
      .integer({ min: 0, max: token.length - 1 })
      .map((index) => `${token.slice(0, index)}${token.slice(index + 1)}`),
    // Catches a `startsWith` / `includes` compare.
    fc.constantFrom(`${token}${token}`, `${token}${token.slice(0, 1)}`),
  ];

  if (letterIndices.length > 0) {
    // Catches a case-insensitive compare. Visually near-identical, byte-different.
    family.push(
      fc
        .constantFrom(...letterIndices)
        .map((index) => replaceAt(token, index, flipCase(token.charCodeAt(index)))),
    );
  }

  const latinA = token.indexOf("a");
  if (latinA !== -1) {
    // Cyrillic а (U+0430) for Latin a: identical on screen, different bytes.
    // Catches a compare that normalises Unicode before comparing.
    family.push(fc.constant(replaceAt(token, latinA, 0x0430)));
  }

  return family;
}

/** The near-miss family as one arbitrary, for use with a generated token. */
function nearMiss(token: string): fc.Arbitrary<string> {
  return fc.oneof(...nearMissFamily(token)).filter((credential) => credential !== token);
}

/**
 * Every wrong credential: the near misses plus the far miss.
 *
 * The unrelated-string branch stays because it is the common case in practice —
 * a stale token from a previous launch, a copied session id, a truncated
 * environment variable — and because its shrinker reports a readable
 * counterexample when something is genuinely broken.
 */
const wrongCredential = fc
  .oneof(...nearMissFamily(LAUNCH_TOKEN), fc.string())
  .filter((credential) => credential !== LAUNCH_TOKEN);

function request(peer: string, path: string, authorization?: string) {
  return {
    headers: authorization === undefined ? {} : { authorization },
    url: path,
    socket: { remoteAddress: peer },
  };
}

describe("Property 10: only the launch token is admitted (R3.4, R3.5)", () => {
  const admit = createAdmission({ token: LAUNCH_TOKEN });

  it("admits the exact launch token on every guarded path", () => {
    fc.assert(
      fc.property(loopbackPeer, guardedPath, (peer, path) => {
        const verdict = admit(request(peer, path, `Bearer ${LAUNCH_TOKEN}`));
        expect(verdict.ok).toBe(true);
      }),
      RUNS,
    );
  });

  it("refuses every credential that is not byte-identical to the launch token", () => {
    fc.assert(
      fc.property(loopbackPeer, guardedPath, wrongCredential, (peer, path, wrong) => {
        const verdict = admit(request(peer, path, `Bearer ${wrong}`));
        expect(verdict).toEqual({ ok: false, status: 401, code: "unauthorized" });
      }),
      RUNS,
    );
  });

  it("refuses a near miss for any launch token, and admits only the exact bytes", () => {
    fc.assert(
      fc.property(
        launchToken.chain((token) => fc.tuple(fc.constant(token), nearMiss(token))),
        loopbackPeer,
        guardedPath,
        ([token, wrong], peer, path) => {
          const admitOne = createAdmission({ token });
          expect(admitOne(request(peer, path, `Bearer ${wrong}`))).toEqual({
            ok: false,
            status: 401,
            code: "unauthorized",
          });
          expect(admitOne(request(peer, path, `Bearer ${token}`)).ok).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("refuses a missing Authorization header", () => {
    fc.assert(
      fc.property(loopbackPeer, guardedPath, (peer, path) => {
        // 401 rather than 403: the peer was fine, the credential was absent.
        expect(admit(request(peer, path))).toEqual({
          ok: false,
          status: 401,
          code: "unauthorized",
        });
      }),
      RUNS,
    );
  });

  it("refuses the right token under the wrong scheme", () => {
    fc.assert(
      fc.property(
        loopbackPeer,
        guardedPath,
        fc.constantFrom("Basic", "Token", "bearer", "BEARER", "Bearer:", ""),
        (peer, path, scheme) => {
          const header = scheme.length === 0 ? LAUNCH_TOKEN : `${scheme} ${LAUNCH_TOKEN}`;
          expect(admit(request(peer, path, header))).toEqual({
            ok: false,
            status: 401,
            code: "unauthorized",
          });
        },
      ),
      RUNS,
    );
  });

  /**
   * The six cases the design names, asserted by construction rather than by
   * sampling.
   *
   * The property above draws all six classes, but a generator only *probably*
   * covers a class on any given run, and a later edit to the family — a filter
   * that silently discards a branch, say — would take one of them away without
   * failing anything. This table cannot lose a case without the diff showing it.
   */
  it("refuses each named adversarial credential", () => {
    const sameLengthVariant = replaceAt(
      LAUNCH_TOKEN,
      0,
      shiftPrintable(LAUNCH_TOKEN.charCodeAt(0), 1),
    );
    const named: ReadonlyArray<readonly [string, string | undefined]> = [
      ["the empty string", "Bearer "],
      ["a trailing space", `Bearer ${LAUNCH_TOKEN} `],
      ["a proper prefix", `Bearer ${LAUNCH_TOKEN.slice(0, -1)}`],
      ["a same-length one-byte variant", `Bearer ${sameLengthVariant}`],
      ["a different auth scheme", `Basic ${LAUNCH_TOKEN}`],
      ["no Authorization header", undefined],
    ];

    expect(sameLengthVariant).toHaveLength(LAUNCH_TOKEN.length);
    expect(sameLengthVariant).not.toBe(LAUNCH_TOKEN);

    for (const [label, header] of named) {
      const verdict = admit(request("127.0.0.1", "/v1/runs", header));
      expect(verdict, label).toEqual({ ok: false, status: 401, code: "unauthorized" });
    }
  });

  it("admits /health with no credential at all (R3.5)", () => {
    fc.assert(
      fc.property(loopbackPeer, (peer) => {
        expect(admit(request(peer, "/health")).ok).toBe(true);
        expect(admit(request(peer, "/health?probe=1")).ok).toBe(true);
      }),
      RUNS,
    );
  });

  it("refuses to construct without a token", () => {
    expect(() => createAdmission({ token: "" })).toThrow(/without a launch token/);
  });

  it("compares tokens of differing length without throwing", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        expect(timingSafeEqualStr(a, b)).toBe(a === b);
      }),
      RUNS,
    );
  });
});

/**
 * ── Property 11's peer generators ────────────────────────────────────────────
 *
 * The interesting draw is never `8.8.8.8`. Any check that gets anywhere near
 * correct refuses a plainly remote address, so a generator built out of
 * `fc.ipV4()` and a handful of RFC1918 constants only ever exercises the far
 * miss — and every weakening worth worrying about survives it.
 *
 * `DECEPTIVE_PEERS` is the near-loopback family instead: the spellings that a
 * naive check waves through. Each entry names the weakening it catches, because
 * a table of look-alike addresses with no stated purpose is the kind of thing a
 * later pass prunes for being repetitive.
 *
 * Two of these deserve their reasoning up front, because refusing them looks
 * wrong until you know what the peer string is:
 *
 *   - `2130706433`, `0177.0.0.1`, `127.1`, `::ffff:7f00:1`, and
 *     `0:0:0:0:0:0:0:1` all *denote* a loopback address in some parser. None of
 *     them is what a kernel hands back: `remoteAddress` comes from
 *     `inet_ntop`, which emits one canonical spelling per family — dotted quad,
 *     compressed IPv6, and dotted quad inside `::ffff:` for a mapped address. So
 *     refusing them costs no legitimate caller and closes off every alternate
 *     encoding at once, which is what an allow-list buys over a parse.
 *   - `localhost` is a *hostname*. It is never a peer address, and admitting it
 *     would mean the allow-list had started matching on something the resolver
 *     controls rather than something the kernel reported.
 *
 * That is the direction the whole set leans: the closed side. `LOOPBACK_PEERS`
 * is deliberately three literal strings and the assertion below pins it at
 * three, so widening it to satisfy a test is a visible change rather than a
 * quiet one.
 */
const DECEPTIVE_PEERS = [
  // A port suffix. Catches `includes("127.0.0.1")` and any check that splits on
  // the wrong separator — and this is the shape a peer *plus* port actually
  // takes in a log line, so it is the one most likely to be pasted in.
  "127.0.0.1:8080",
  "[::1]:8080",
  // Bracketed, as a URL authority writes it rather than as a socket reports it.
  "[::1]",
  // 127/8 that is not 127.0.0.1. Catches `startsWith("127.")`, which is the
  // single most likely weakening: it reads as correct, and 127/8 is entirely
  // loopback, so the mistake only bites through a *mapped* or spoofed peer.
  "127.0.0.2",
  "127.1.2.3",
  "127.255.255.255",
  // Short, octal, hex, and decimal-integer forms. Catches a check that parses
  // rather than matches, since every one of these parses to 127.0.0.1.
  "127.1",
  "127.0.1",
  "0177.0.0.1",
  "017700000001",
  "0x7f.0.0.1",
  "0x7f000001",
  "0x7F000001",
  "2130706433",
  // Zero-padded dotted quad. Parses to 127.0.0.1 through `inet_aton` and reads
  // as the canonical spelling at a glance, which is what makes it worth naming
  // separately from the octal entries above — the padding *is* the octal.
  "127.000.000.001",
  "127.0.0.01",
  // The hex-encoded IPv4-mapped form. Catches a check that compares mapped
  // addresses after normalising them, and it is the entry most likely to be
  // read as a false refusal — see the note above on `inet_ntop`.
  "::ffff:7f00:1",
  "::ffff:7f00:0001",
  // Mapped, but not mapped to 127.0.0.1.
  "::ffff:127.0.0.2",
  "::ffff:10.0.0.1",
  // Case variants of the one mapped spelling that *is* admitted. Catches a
  // case-insensitive compare, which would be indistinguishable from the exact
  // match on every legitimate connection.
  "::FFFF:127.0.0.1",
  "::fFfF:127.0.0.1",
  // The uncompressed IPv6 loopback. Catches `endsWith(":1")`.
  "0:0:0:0:0:0:0:1",
  "0000:0000:0000:0000:0000:0000:0000:0001",
  // Alternate compressions of the same address. Catches a check that strips
  // leading zeros from the final group before comparing.
  "::01",
  "::0001",
  "0::1",
  // A zone-qualified spelling. Catches a check that strips a `%` suffix before
  // comparing. Left in the refused set on purpose: on Linux a loopback peer
  // carries no zone, and admitting a suffix the kernel never produces would
  // widen the boundary for nothing.
  "::1%lo",
  "::1%0",
  // A hostname rather than an address.
  "localhost",
  "LOCALHOST",
  "localhost.",
  "localhost.localdomain",
  "ip6-localhost",
  // Leading and trailing whitespace. Catches a check that trims — the shape a
  // value copied out of a config file or an environment variable arrives in.
  " 127.0.0.1",
  "127.0.0.1 ",
  "\t127.0.0.1",
  "127.0.0.1\n",
  " ::1",
  "::1\r\n",
  // Absent. Catches the open-by-default reading of a missing peer, which is the
  // one case where "no information" must not mean "allowed".
  "",
  " ",
  // Wildcards, which are a bind address rather than a peer address.
  "0.0.0.0",
  "::",
  "::0",
  // And the far miss, which is what an actual remote probe looks like.
  "203.0.113.7",
  "10.0.0.1",
  "192.168.1.10",
  "169.254.169.254",
  "8.8.8.8",
  "fe80::1",
  "2001:db8::1",
] as const;

/** 127/8 minus the one canonical spelling — the `startsWith("127.")` hole. */
const loopbackRangeImpostor = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map(([b, c, d]) => `127.${b}.${c}.${d}`)
  .filter((peer) => peer !== "127.0.0.1");

/**
 * Every non-loopback peer, weighted towards the near misses.
 *
 * `fc.ipV4Extended()` earns its place here rather than duplicating the octal and
 * decimal-integer entries above: it draws the whole extended-notation space
 * rather than the four spellings a human thought to write down.
 */
const remotePeer = fc
  .oneof(
    { arbitrary: fc.constantFrom(...DECEPTIVE_PEERS), weight: 5 },
    { arbitrary: loopbackRangeImpostor, weight: 3 },
    { arbitrary: fc.ipV4Extended(), weight: 2 },
    { arbitrary: fc.ipV4(), weight: 1 },
    { arbitrary: fc.ipV6(), weight: 1 },
  )
  .filter((peer) => !LOOPBACK_PEERS.has(peer));

/**
 * Loopback and non-loopback peers together, weighted towards the refused side.
 *
 * Only the agreement property below draws from this. Every other assertion in
 * the block wants one side or the other, and a generator that mixed them would
 * make those assertions say "whichever side was drawn" instead of a claim.
 */
const anyPeer = fc.oneof(
  { arbitrary: remotePeer, weight: 3 },
  { arbitrary: loopbackPeer, weight: 1 },
);

/**
 * Every credential a refused peer might present, the correct one included.
 *
 * The correct token is the load-bearing draw. R3.6 is not "a remote caller
 * without a credential is refused" — a stolen or leaked token must buy a remote
 * peer nothing at all, which is the only reason the peer check is worth putting
 * ahead of the credential check.
 */
const anyCredential = fc.oneof(
  fc.constant(undefined),
  fc.constant(`Bearer ${LAUNCH_TOKEN}`),
  fc.constant(`Bearer ${LAUNCH_TOKEN} `),
  fc.constant("Bearer "),
  fc.constant(LAUNCH_TOKEN),
  fc.constant(`Basic ${LAUNCH_TOKEN}`),
  fc.string().map((s) => `Bearer ${s}`),
);

/** Guarded and unauthenticated paths together: the loopback check covers both. */
const anyPath = fc.oneof(
  guardedPath,
  fc.constantFrom("/health", "/health?probe=1", "/", "/v1", "/v1/../health"),
);

/**
 * A request whose `headers` object records every property read from it.
 *
 * This is how the ordering claim gets asserted rather than inspected. `admit`
 * could refuse a remote peer with the right verdict while still having read the
 * credential on the way there — the returned value looks identical either way,
 * and only the access trace tells them apart.
 */
function recordingRequest(peer: string | undefined, path: string, authorization?: string) {
  const reads: string[] = [];
  const backing: IncomingHttpHeaders = authorization === undefined ? {} : { authorization };
  const headers = new Proxy(backing, {
    get(target, property, receiver) {
      if (typeof property === "string") reads.push(property);
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (typeof property === "string") reads.push(property);
      return Reflect.has(target, property);
    },
  });
  return {
    reads,
    req: {
      headers,
      url: path,
      socket: peer === undefined ? {} : { remoteAddress: peer },
    },
  };
}

/**
 * Connect to a loopback listener on `host` and report the peer address the
 * kernel gave the server side.
 *
 * Returns null when the address family is unavailable, which is the honest
 * answer on a box with IPv6 disabled — the alternative is a test that fails for
 * a reason that has nothing to do with admission.
 */
async function observedPeerAddress(host: string): Promise<string | null> {
  return await new Promise<string | null>((resolveAddress) => {
    const server = createServer();
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      server.close();
      resolveAddress(value);
    };

    server.once("error", () => finish(null));
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        finish(null);
        return;
      }
      server.once("connection", (socket) => {
        const peer = socket.remoteAddress ?? null;
        socket.destroy();
        finish(peer);
      });
      // A `::` listener is reached over IPv4 on purpose: that is the only way to
      // produce the `::ffff:` mapped form the allow-list carries a spelling for.
      const client = createConnection({
        host: host === "::" ? "127.0.0.1" : host,
        port: address.port,
      });
      client.once("error", () => finish(null));
      client.once("connect", () => client.end());
      setTimeout(() => finish(null), 2_000).unref();
    });
  });
}

/**
 * Property 11: Only loopback peers are admitted.
 *
 * *For any* remote address outside the loopback set, the Agent_Runtime refuses
 * the request without evaluating the credential; and every address in the
 * loopback set is admitted.
 *
 * **Validates: Requirements 3.6**
 */
describe("Property 11: only loopback peers are admitted (R3.6)", () => {
  const admit = createAdmission({ token: LAUNCH_TOKEN });

  const refused = { ok: false, status: 403, code: "remote_refused" } as const;

  it("refuses every non-loopback peer, for any credential, on any path", () => {
    fc.assert(
      fc.property(remotePeer, anyPath, anyCredential, (peer, path, authorization) => {
        // 403 and never 401: a remote prober must not learn that its peer was
        // acceptable and only its credential was not.
        expect(admit(request(peer, path, authorization))).toEqual(refused);
      }),
      RUNS,
    );
  });

  it("refuses a non-loopback peer whatever launch token the runtime holds", () => {
    fc.assert(
      fc.property(launchToken, remotePeer, anyPath, (token, peer, path) => {
        const admitOne = createAdmission({ token });
        // Presenting that launch token buys the remote peer nothing.
        expect(admitOne(request(peer, path, `Bearer ${token}`))).toEqual(refused);
        expect(admitOne(request(peer, path))).toEqual(refused);
      }),
      RUNS,
    );
  });

  /**
   * The deceptive family asserted by construction rather than by sampling.
   *
   * The property above draws from `DECEPTIVE_PEERS`, but a generator only
   * *probably* covers a given entry on a given run, and the filter in
   * `remotePeer` could silently swallow one after an edit to `LOOPBACK_PEERS`.
   * This loop cannot lose an entry without the diff showing it, and it asserts
   * every entry on both a guarded path and `/health` while presenting the
   * correct token — the combination with the most ways to go wrong.
   */
  it("refuses each named near-loopback spelling on every path, holding the real token", () => {
    const credential = `Bearer ${LAUNCH_TOKEN}`;
    for (const peer of DECEPTIVE_PEERS) {
      for (const path of ["/v1/runs", "/health", "/health?probe=1"]) {
        expect(admit(request(peer, path, credential)), `${peer} ${path}`).toEqual(refused);
        expect(admit(request(peer, path)), `${peer} ${path} (no credential)`).toEqual(refused);
      }
    }
  });

  it("refuses a peer it cannot read at all", () => {
    const credential = `Bearer ${LAUNCH_TOKEN}`;
    // Three ways a peer can be absent rather than wrong. Each lands closed: an
    // unreadable peer is the case where "no information" must not mean "local".
    expect(admit({ headers: { authorization: credential }, url: "/v1/runs" })).toEqual(refused);
    expect(admit({ headers: { authorization: credential }, url: "/v1/runs", socket: {} })).toEqual(
      refused,
    );
    expect(
      admit({
        headers: { authorization: credential },
        url: "/health",
        socket: { remoteAddress: undefined },
      }),
    ).toEqual(refused);
  });

  it("admits every spelling in the loopback set", () => {
    // Exhaustive rather than sampled: the set is three literals, so enumeration
    // is both cheaper and stronger than drawing from it.
    for (const peer of LOOPBACK_PEERS) {
      // `/health` needs no credential (R3.5) …
      expect(admit(request(peer, "/health")).ok, peer).toBe(true);
      // … and a guarded path needs the token and nothing about the peer.
      expect(admit(request(peer, "/v1/runs", `Bearer ${LAUNCH_TOKEN}`)).ok, peer).toBe(true);
    }
  });

  it("pins the allow-list at exactly three spellings", () => {
    // This assertion exists to fail. A trust-boundary allow-list that grows to
    // make something else pass is the wrong repair, so growing it breaks a test
    // whose only subject is its size.
    expect([...LOOPBACK_PEERS].sort()).toEqual(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  });

  it("never reads the credential for a non-loopback peer", () => {
    fc.assert(
      fc.property(remotePeer, anyPath, anyCredential, (peer, path, authorization) => {
        const { reads, req } = recordingRequest(peer, path, authorization);
        expect(admit(req)).toEqual(refused);
        // Nothing was read off the headers, so there is no code path along which
        // response time could vary with the token's length or content.
        expect(reads).toEqual([]);
      }),
      RUNS,
    );
  });

  it("does read the credential for a loopback peer, so the trace above means something", () => {
    // The control for the assertion above. If `admit` never touched the headers
    // at all, an empty access trace would prove nothing about ordering.
    fc.assert(
      fc.property(loopbackPeer, guardedPath, (peer, path) => {
        const { reads, req } = recordingRequest(peer, path, `Bearer ${LAUNCH_TOKEN}`);
        expect(admit(req).ok).toBe(true);
        expect(reads).toContain("authorization");
      }),
      RUNS,
    );
  });

  it("reaches a verdict for a remote peer even if reading the credential would throw", () => {
    // Belt and braces on the same ordering claim, under a harsher condition
    // than a recorder: a header bag that cannot be read without failing.
    const trap = {
      url: "/v1/runs",
      socket: { remoteAddress: "203.0.113.7" },
      headers: new Proxy({} as Record<string, string>, {
        get() {
          throw new Error("credential was read for a non-loopback peer");
        },
      }),
    };
    expect(admit(trap)).toEqual(refused);
  });

  it("says nothing about the peer or the credential when it refuses", () => {
    fc.assert(
      fc.property(remotePeer, anyPath, (peer, path) => {
        const verdict = admit(request(peer, path, `Bearer ${LAUNCH_TOKEN}`));
        expect(verdict.ok).toBe(false);
        if (verdict.ok) return;
        const refusal = refusalEnvelope(verdict.code);
        const body = JSON.stringify(refusal);
        // The refusal is the one response a remote caller ever sees, so it is
        // also the one place a peer address or a token could leak into.
        expect(body).not.toContain(LAUNCH_TOKEN);
        if (peer.trim().length > 0) expect(body).not.toContain(peer.trim());
        expect(refusal.details).toBeNull();
        // Not retryable, and that is a claim rather than a default: the
        // renderer draws its retry affordance straight off this flag, and
        // retrying from the same peer cannot ever succeed.
        expect(refusal.retryable).toBe(false);
      }),
      RUNS,
    );
  });

  it("admits exactly what it classifies as loopback, for any peer at all", () => {
    // Ties the exported classifier to the middleware's own verdict. Both are
    // asserted above, but separately, which leaves one hole between them: a
    // refactor that inlined a *different* check inside `admit` would keep the
    // classification table green while the boundary itself moved. Agreement on
    // every draw is what closes it, in both directions at once — a widening on
    // either side shows up here.
    fc.assert(
      fc.property(anyPeer, guardedPath, (peer, path) => {
        const verdict = admit(request(peer, path, `Bearer ${LAUNCH_TOKEN}`));
        expect(verdict.ok, peer).toBe(isLoopbackPeer(peer));
        if (!verdict.ok) expect(verdict).toEqual(refused);
      }),
      RUNS,
    );
  });

  it("classifies exactly the loopback set and nothing adjacent to it", () => {
    for (const peer of LOOPBACK_PEERS) expect(isLoopbackPeer(peer), peer).toBe(true);
    for (const peer of DECEPTIVE_PEERS) expect(isLoopbackPeer(peer), peer).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  it("covers every peer spelling this platform's sockets actually report", async () => {
    // The other direction of the property: the allow-list must not refuse a
    // caller that is genuinely local. Asserted against real sockets rather than
    // reasoned about, because the claim is about what `inet_ntop` emits on this
    // platform, and that is not something a table of string literals can know.
    const probes = await Promise.all(
      ["127.0.0.1", "::1", "::"].map(async (host) => ({
        host,
        peer: await observedPeerAddress(host),
      })),
    );

    const observed = probes.filter((probe) => probe.peer !== null);
    // A sandbox with no loopback networking cannot demonstrate this. Recording
    // that honestly beats failing for an unrelated reason.
    if (observed.length === 0) return;

    for (const { host, peer } of observed) {
      expect(isLoopbackPeer(peer ?? undefined), `${host} reported ${peer}`).toBe(true);
    }
  });
});

describe("header and path helpers", () => {
  it("extracts only a Bearer credential", () => {
    expect(presentedToken({ headers: { authorization: "Bearer abc" } })).toBe("abc");
    expect(presentedToken({ headers: { authorization: "Basic abc" } })).toBe("");
    expect(presentedToken({ headers: {} })).toBe("");
  });

  it("drops the query string when resolving a path", () => {
    fc.assert(
      fc.property(
        fc
          .array(fc.hexaString({ minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 4 })
          .map((segments) => `/${segments.join("/")}`),
        fc.string(),
        (path, query) => {
          expect(requestPath(`${path}?${query}`)).toBe(path);
        },
      ),
      RUNS,
    );
  });
});
