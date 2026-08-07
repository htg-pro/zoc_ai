/**
 * Property 62: Same-file writes serialise, and the loser goes stale.
 * Validates R25.7.
 *
 * Feature: zoc-agent-chat-rebuild, Property 62 (R25.7), task 29.5.
 *
 * ## Why this drives `WorkspaceClient` rather than `PathMutex`
 *
 * `PathMutex` had unit coverage from 9.13 and no production caller: the lock existed,
 * was correct in isolation, and served no apply. So a property asserted against the
 * class would have passed against a runtime that clobbered files. The subject here is
 * therefore the wired path — `WorkspaceClient.applyHunks`, R10.16's single mutation
 * path — with one client shared across the concurrent Runs, which is the production
 * topology: `composition.ts` builds exactly one per process.
 *
 * ## Why the fake bridge yields between its read and its write
 *
 * A stub that read and wrote in one synchronous turn would serialise applies by
 * accident and this file would pass with the lock removed. Desktop_Core's real bridge
 * serves **one thread per connection** and `handle_apply_hunks` takes no lock, so the
 * window between its `std::fs::read` and its `tx.commit()` is genuinely open. The
 * `setTimeout` below is that window, and it is what makes the property falsifiable —
 * with `runAll` bypassed, the first case fails with every apply reporting success.
 *
 * ## Why "the loser goes stale" needs no separate mechanism
 *
 * The lock only orders. Once the winner's bytes are on disk the loser's `base_digest`
 * no longer matches what the bridge reads, and R10.8's existing check refuses it with
 * `hunk_stale` — one staleness path, reached by a human edit and by a lost race alike.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { WorkspaceClient } from "../workspace-client.ts";

const RUNS = { numRuns: 40 } as const;

/** Content-addressed like the bridge's `digest_of`; only that it moves with content matters. */
const digestOf = (content: string): string => `sha256:${String(content.length)}:${content}`;

interface Bridge {
  readonly fetchImpl: typeof fetch;
  content(path: string): string;
  /** `run_id`s the bridge accepted and wrote, in commit order. */
  readonly accepted: string[];
}

/** An in-memory workspace behind a `fetch` stub that models `handle_apply_hunks`. */
function fakeBridge(paths: readonly string[]): Bridge {
  const files = new Map(paths.map((path) => [path, "base"]));
  const accepted: string[] = [];

  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as {
      run_id: string;
      files: { path: string; base_digest: string | null; unified_diff: string }[];
    };
    const json = (value: unknown, status: number): Response =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });

    // Read every target first, as the Rust does.
    const originals = body.files.map((file) => files.get(file.path) ?? "");
    const isStale = body.files.some(
      (file, index) =>
        file.base_digest !== null && file.base_digest !== digestOf(originals[index] as string),
    );
    // R10.8 — a digest mismatch refuses the whole batch and writes nothing.
    if (isStale) return json({ code: "hunk_stale", message: "the file changed" }, 409);

    // The open window. See the module comment: this is the bug the lock closes, not a
    // convenience of the stub.
    await new Promise((resolve) => setTimeout(resolve, 1));

    body.files.forEach((file, index) => {
      files.set(file.path, `${originals[index] as string}+${file.unified_diff}`);
    });
    accepted.push(body.run_id);
    return json({ plan_id: "p", checkpoint_id: null, applied: [] }, 200);
  };

  return {
    fetchImpl: fetchImpl as unknown as typeof fetch,
    content: (path) => files.get(path) ?? "",
    accepted,
  };
}

/** One client for every Run, which is what `composition.ts` builds. */
function clientOn(bridge: Bridge): WorkspaceClient {
  return new WorkspaceClient({
    bridgeUrl: "http://127.0.0.1:9/bridge",
    servicesUrl: null,
    token: "token-0123456789",
    fetchImpl: bridge.fetchImpl,
  });
}

function applyOne(
  client: WorkspaceClient,
  run: number,
  paths: readonly string[],
  baseDigest: string | null,
) {
  return client.applyHunks({
    planId: `plan_${String(run)}`,
    runId: `run_${String(run)}`,
    files: paths.map((path) => ({
      path,
      action: "modify" as const,
      unifiedDiff: `w${String(run)}`,
      baseDigest,
    })),
  });
}

describe("Property 62: same-file writes serialise and the loser goes stale (R25.7)", () => {
  it("lets exactly one of N concurrent same-file applies win, and refuses the rest as stale", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (runs) => {
        const bridge = fakeBridge(["src/a.ts"]);
        const client = clientOn(bridge);
        const base = digestOf("base");

        const outcomes = await Promise.all(
          Array.from({ length: runs }, (_, run) => applyOne(client, run, ["src/a.ts"], base)),
        );

        // Every apply carried the same base, so at most one can legally land.
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        for (const outcome of outcomes) {
          // Narrowed by the guard rather than by a predicate filter, so the refusal
          // code is read off the error member the union actually declares.
          if (outcome.ok) continue;
          expect(outcome.code).toBe("hunk_stale");
        }
        // One write, not N and not a blend of them — the clobber this exists to catch.
        expect(bridge.accepted).toHaveLength(1);
        const winner = (bridge.accepted[0] as string).replace("run_", "");
        expect(bridge.content("src/a.ts")).toBe(`base+w${winner}`);
      }),
      RUNS,
    );
  });

  it("never serialises applies to disjoint files", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (runs) => {
        const paths = Array.from({ length: runs }, (_, i) => `src/f${String(i)}.ts`);
        const bridge = fakeBridge(paths);
        const client = clientOn(bridge);

        const outcomes = await Promise.all(
          paths.map((path, run) => applyOne(client, run, [path], digestOf("base"))),
        );

        // The other half of R25.7: a lock that ordered everything would defeat the
        // point of running Runs in parallel, and would pass the first case alone.
        expect(outcomes.every((r) => r.ok)).toBe(true);
        expect(bridge.accepted).toHaveLength(runs);
      }),
      RUNS,
    );
  });

  it("does not deadlock when two batches request the same paths in opposite orders", async () => {
    const bridge = fakeBridge(["src/a.ts", "src/b.ts"]);
    const client = clientOn(bridge);
    const base = digestOf("base");

    // The classic two-lock cycle. `runAll` sorts, so both take `src/a.ts` first and the
    // cycle cannot form; an implementation locking in caller order hangs here, so the
    // race gives that a named failure instead of a suite-level timeout.
    const applies = Promise.all([
      applyOne(client, 0, ["src/a.ts", "src/b.ts"], base),
      applyOne(client, 1, ["src/b.ts", "src/a.ts"], base),
    ]);
    const outcomes = await Promise.race([
      applies,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("deadlocked")), 2_000)),
    ]);

    // Both batches touch both files, so the second is stale on arrival — the assertion
    // that matters here is that it *arrived* rather than what it returned.
    expect(Array.isArray(outcomes)).toBe(true);
    expect(bridge.accepted).toHaveLength(1);
  });
});
