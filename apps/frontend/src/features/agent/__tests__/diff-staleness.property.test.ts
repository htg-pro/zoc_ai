// Feature: zoc-ai-agent-chat-overhaul, Property 43: Diff staleness is decided by current SHA-256/existence vs baseHash
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { anyFileStale, fileStale, type FileProbe } from "../diff-staleness";

describe("fileStale (R12.7)", () => {
  it("never derives staleness without a recorded baseHash", () => {
    fc.assert(
      fc.property(
        fc.record({ exists: fc.boolean(), sha256: fc.option(fc.hexaString(), { nil: null }) }),
        (probe: FileProbe) => {
          expect(fileStale(null, probe)).toBe(false);
        },
      ),
      { numRuns: 120 },
    );
  });

  it("is stale when the file is gone or the current hash differs; fresh when equal/unknown", () => {
    // Missing file with a recorded baseline → stale.
    expect(fileStale("abc", { exists: false, sha256: null })).toBe(true);
    // Divergent hash → stale (case-insensitive compare).
    expect(fileStale("abc", { exists: true, sha256: "def" })).toBe(true);
    expect(fileStale("ABC", { exists: true, sha256: "abc" })).toBe(false);
    // Matching hash → not stale.
    expect(fileStale("abc", { exists: true, sha256: "abc" })).toBe(false);
    // Unknown current hash (unreadable) but file present → not stale (no evidence).
    expect(fileStale("abc", { exists: true, sha256: null })).toBe(false);
    // No probe at all → not stale.
    expect(fileStale("abc", null)).toBe(false);
  });

  it("anyFileStale is true iff some file with a baseHash diverged", () => {
    const files = [
      { path: "a", baseHash: "h1" },
      { path: "b", baseHash: null },
    ];
    const probes = new Map<string, FileProbe | null>([
      ["a", { exists: true, sha256: "h1" }],
      ["b", { exists: false, sha256: null }],
    ]);
    expect(anyFileStale(files, probes)).toBe(false);
    probes.set("a", { exists: true, sha256: "changed" });
    expect(anyFileStale(files, probes)).toBe(true);
  });
});
