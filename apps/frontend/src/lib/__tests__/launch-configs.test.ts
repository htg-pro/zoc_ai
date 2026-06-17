import { describe, it, expect } from "vitest";
import { parseLaunchJson } from "@/lib/launch-configs";

describe("parseLaunchJson", () => {
  it("parses configurations and classifies the adapter family", () => {
    const json = `{
      // VS Code launch file
      "version": "0.2.0",
      "configurations": [
        { "name": "Debug API", "type": "python", "request": "launch", "program": "main.py" },
        { "name": "Debug Web", "type": "pwa-node", "request": "launch", "args": ["--port", "3000"] },
        { "name": "Debug Bin", "type": "lldb", "request": "launch", "cwd": "crates/hotpath" },
      ]
    }`;
    const configs = parseLaunchJson(json);
    expect(configs).toHaveLength(3);
    expect(configs[0]).toMatchObject({ name: "Debug API", kind: "python", program: "main.py" });
    expect(configs[1]).toMatchObject({ name: "Debug Web", kind: "node", args: ["--port", "3000"] });
    expect(configs[2]).toMatchObject({ name: "Debug Bin", kind: "rust", cwd: "crates/hotpath" });
  });

  it("returns [] for malformed or empty docs", () => {
    expect(parseLaunchJson("not json")).toEqual([]);
    expect(parseLaunchJson("{}")).toEqual([]);
    expect(parseLaunchJson('{"configurations": [{ "request": "launch" }]}')).toEqual([]);
  });
});
