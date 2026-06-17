import { describe, it, expect } from "vitest";
import {
  dedupeTasks,
  defaultBuildTask,
  defaultTestTask,
  detectCargo,
  detectMake,
  detectNpmScripts,
  detectPython,
  parseTasksJson,
  stripJsonComments,
} from "@/lib/tasks";

describe("stripJsonComments", () => {
  it("removes line/block comments and trailing commas, keeps string content", () => {
    const src = `{
      // a line comment
      "a": 1, /* block */
      "b": "http://x // not a comment",
      "c": [1, 2,],
    }`;
    const parsed = JSON.parse(stripJsonComments(src));
    expect(parsed).toEqual({ a: 1, b: "http://x // not a comment", c: [1, 2] });
  });
});

describe("parseTasksJson", () => {
  it("parses VS Code tasks including npm script + matcher + group", () => {
    const json = `{
      "version": "2.0.0",
      "tasks": [
        { "label": "build", "type": "shell", "command": "make", "args": ["all"],
          "group": { "kind": "build", "isDefault": true }, "problemMatcher": "$tsc" },
        { "label": "lint", "type": "npm", "script": "lint" }
      ]
    }`;
    const tasks = parseTasksJson(json, "vscode");
    expect(tasks).toHaveLength(2);
    expect(tasks[0]).toMatchObject({
      id: "vscode:build",
      command: "make",
      args: ["all"],
      group: "build",
      problemMatcher: "tsc",
      source: "vscode",
    });
    expect(tasks[1]).toMatchObject({ command: "npm", args: ["run", "lint"] });
  });
});

describe("detectors", () => {
  it("detects npm scripts and classifies build/test", () => {
    const pkg = JSON.stringify({ scripts: { build: "vite build", test: "vitest", dev: "vite" } });
    const tasks = detectNpmScripts(pkg);
    const build = tasks.find((t) => t.id === "npm:build")!;
    const test = tasks.find((t) => t.id === "npm:test")!;
    expect(build.group).toBe("build");
    expect(build.args).toEqual(["run", "build"]);
    expect(test.group).toBe("test");
  });

  it("detects cargo build/test/check", () => {
    const tasks = detectCargo("[package]\nname = \"x\"\n");
    expect(tasks.map((t) => t.id)).toEqual(["cargo:build", "cargo:test", "cargo:check"]);
    expect(tasks[0].problemMatcher).toBe("cargo");
    expect(tasks[1].group).toBe("test");
  });

  it("detects Makefile targets and skips .PHONY", () => {
    const mk = ".PHONY: build test\nbuild:\n\tcargo build\ntest:\n\tcargo test\nVAR := 1\n";
    const tasks = detectMake(mk);
    expect(tasks.map((t) => t.args[0])).toEqual(["build", "test"]);
    expect(tasks[0].group).toBe("build");
    expect(tasks[1].group).toBe("test");
  });

  it("detects python pytest/ruff", () => {
    const tasks = detectPython("[tool.pytest.ini_options]\n[tool.ruff]\n");
    expect(tasks.map((t) => t.id)).toEqual(["python:pytest", "python:ruff"]);
    expect(tasks[0].group).toBe("test");
    expect(tasks[1].problemMatcher).toBe("ruff");
  });
});

describe("dedupe + defaults", () => {
  it("dedupes by id keeping the first", () => {
    const a = detectCargo("[package]");
    const merged = dedupeTasks([...a, ...a]);
    expect(merged).toHaveLength(3);
  });

  it("prefers a config build/test task as the default", () => {
    const tasks = [
      ...parseTasksJson(
        `{"tasks":[{"label":"ci-build","command":"x","group":"build"}]}`,
        "vscode",
      ),
      ...detectCargo("[package]"),
    ];
    expect(defaultBuildTask(tasks)?.id).toBe("vscode:ci-build");
    expect(defaultTestTask(tasks)?.id).toBe("cargo:test");
  });
});
