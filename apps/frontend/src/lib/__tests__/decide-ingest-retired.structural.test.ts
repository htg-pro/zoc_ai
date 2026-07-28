// Feature: zoc-ai-agent-chat-overhaul, Task 12.10: `decideIngest` has no importers
//
// `decideIngest` is retired (task 12.9): the Event_Normalizer
// (`features/agent/normalize.ts`) is the single path that decides what enters
// the feed, owning the cross-run, duplicate-seq, and malformed discard rules
// (R9.6). This structural test asserts the retirement cannot silently regress
// into a second ingest gate: no source file under `apps/frontend/src` may
// reference `decideIngest`, and `event-ingest.ts` must no longer export it.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const SRC = path.resolve(ROOT, "src");

/** This test file's own path, so scanning skips it (it names the symbol). */
const SELF = path.resolve(SRC, "lib/__tests__/decide-ingest-retired.structural.test.ts");

/** Every `.ts`/`.tsx` source file under `src`, minus this test. */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectSources(full, out);
    } else if (/\.tsx?$/.test(entry) && full !== SELF) {
      out.push(full);
    }
  }
  return out;
}

describe("decideIngest retirement (Task 12.10)", () => {
  it("no source file imports or calls decideIngest", () => {
    // An importer (`import { … decideIngest … }`) or a call (`decideIngest(`)
    // is the regression this guards against; a prose mention of the retired
    // symbol in a doc comment is allowed and does not reintroduce the gate.
    const importsIt = (src: string) =>
      /import\b[^;]*\bdecideIngest\b[^;]*from/.test(src);
    const callsIt = (src: string) => /\bdecideIngest\s*\(/.test(src);
    const offenders = collectSources(SRC).filter((file) => {
      const src = readFileSync(file, "utf-8");
      return importsIt(src) || callsIt(src);
    });
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it("event-ingest.ts no longer exports decideIngest, IngestState, or IngestDecision", () => {
    const source = readFileSync(path.resolve(SRC, "lib/event-ingest.ts"), "utf-8");
    expect(source).not.toMatch(/export\s+function\s+decideIngest/);
    expect(source).not.toMatch(/export\s+(?:type\s+)?IngestDecision/);
    expect(source).not.toMatch(/export\s+interface\s+IngestState/);
    // The surviving helpers stay (they have no overlap with normalization).
    expect(source).toMatch(/export\s+function\s+upsertById/);
    expect(source).toMatch(/export\s+function\s+drainBuffer/);
    expect(source).toMatch(/export\s+function\s+applyPlanStep/);
    expect(source).toMatch(/export\s+function\s+errorDetail/);
    expect(source).toMatch(/export\s+function\s+toolCallStatusLabel/);
    expect(source).toMatch(/export\s+function\s+eventEntryId/);
  });
});
