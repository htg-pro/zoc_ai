import { describe, expect, it } from "vitest";
import {
  buildRunTargets,
  defaultRunTarget,
  parseTargetId,
} from "@/lib/run-targets";
import type { LaunchConfig } from "@/lib/launch-configs";
import type { Task } from "@/lib/tasks";

const cfg = (name: string, kind: LaunchConfig["kind"] = "node"): LaunchConfig => ({
  name,
  type: kind,
  request: "launch",
  kind,
});

const task = (label: string, group: Task["group"], source: Task["source"] = "npm"): Task => ({
  id: `${source}:${label}`,
  label,
  source,
  command: "x",
  args: [],
  group,
  problemMatcher: null,
});

describe("buildRunTargets", () => {
  it("lists debug configs first, then tasks ordered build → test → other", () => {
    const targets = buildRunTargets(
      [cfg("Launch Program")],
      [task("lint", "none"), task("build", "build"), task("unit", "test")],
    );
    expect(targets.map((t) => t.id)).toEqual([
      "debug:Launch Program",
      "npm:build",
      "npm:unit",
      "npm:lint",
    ]);
    expect(targets[0]).toMatchObject({ kind: "debug", detail: "node" });
    expect(targets[1]).toMatchObject({ kind: "task", detail: "npm" });
  });

  it("handles empty inputs", () => {
    expect(buildRunTargets([], [])).toEqual([]);
  });
});

describe("defaultRunTarget", () => {
  const targets = buildRunTargets([cfg("Dbg")], [task("build", "build")]);

  it("returns the selected target when present", () => {
    expect(defaultRunTarget(targets, "npm:build")?.id).toBe("npm:build");
  });

  it("falls back to the first target when selection is missing/stale", () => {
    expect(defaultRunTarget(targets, null)?.id).toBe("debug:Dbg");
    expect(defaultRunTarget(targets, "gone")?.id).toBe("debug:Dbg");
  });

  it("returns null when there are no targets", () => {
    expect(defaultRunTarget([], "x")).toBeNull();
  });
});

describe("parseTargetId", () => {
  it("splits debug vs task ids", () => {
    expect(parseTargetId("debug:Launch Program")).toEqual({ kind: "debug", name: "Launch Program" });
    expect(parseTargetId("npm:build")).toEqual({ kind: "task", name: "npm:build" });
  });
});
