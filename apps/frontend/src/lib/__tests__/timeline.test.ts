import { describe, expect, it } from "vitest";
import { buildTimeline } from "@/lib/timeline";
import type { GitCommit } from "@/lib/tauri-bridge";
import type { CheckpointInfo } from "@zoc-studio/shared-types";

const commit = (over: Partial<GitCommit>): GitCommit => ({
  hash: "abc123",
  short: "abc123",
  author: "Dev",
  email: "dev@x",
  timestamp: 1000,
  subject: "do a thing",
  ...over,
});

const checkpoint = (over: Partial<CheckpointInfo>): CheckpointInfo => ({
  run_id: "run-1",
  label: "Agent run",
  created_at: new Date(2_000_000).toISOString(),
  files: ["a.ts"],
  ...over,
});

describe("buildTimeline", () => {
  it("merges commits and checkpoints, newest first", () => {
    const commits = [commit({ hash: "old", timestamp: 1000 }), commit({ hash: "new", timestamp: 3000 })];
    const checkpoints = [checkpoint({ run_id: "r", created_at: new Date(2_000_000).toISOString() })];
    const entries = buildTimeline(commits, checkpoints);
    // commit "new" = 3000s = 3_000_000ms (latest), then checkpoint 2_000_000ms, then commit "old" 1_000_000ms
    expect(entries.map((e) => e.id)).toEqual(["commit:new", "checkpoint:r", "commit:old"]);
  });

  it("maps commit fields (seconds → ms) and subtitles", () => {
    const [e] = buildTimeline([commit({ hash: "h", short: "hsh", author: "Ada", timestamp: 5 })], []);
    expect(e).toMatchObject({ kind: "commit", title: "do a thing", ts: 5000 });
    expect(e.subtitle).toContain("Ada");
    expect(e.subtitle).toContain("hsh");
  });

  it("maps checkpoint fields and carries runId", () => {
    const [e] = buildTimeline([], [checkpoint({ run_id: "rx", files: ["a", "b"] })]);
    expect(e).toMatchObject({ kind: "checkpoint", runId: "rx" });
    expect(e.subtitle).toBe("2 files");
  });

  it("tolerates an unparseable checkpoint date (ts = 0)", () => {
    const [e] = buildTimeline([], [checkpoint({ created_at: "not-a-date" })]);
    expect(e.ts).toBe(0);
  });

  it("handles empty inputs", () => {
    expect(buildTimeline([], [])).toEqual([]);
  });
});
