import { describe, expect, it } from "vitest";
import {
  detectTransport,
  isToolAutoApproved,
  loadMcpServers,
  mergeMcpServers,
  parseMcpConfig,
} from "@/lib/mcp-config";

describe("detectTransport", () => {
  it("uses explicit type/transport first", () => {
    expect(detectTransport({ type: "streamable-http", url: "https://x" })).toBe("http");
    expect(detectTransport({ transport: "sse", url: "https://x" })).toBe("sse");
    expect(detectTransport({ type: "stdio", command: "x" })).toBe("stdio");
  });
  it("infers from command/url", () => {
    expect(detectTransport({ command: "uvx" })).toBe("stdio");
    expect(detectTransport({ url: "https://x" })).toBe("sse");
    expect(detectTransport({})).toBe("stdio");
  });
});

describe("parseMcpConfig", () => {
  it("parses stdio servers with args/env/autoApprove/disabled", () => {
    const text = JSON.stringify({
      mcpServers: {
        "aws-docs": {
          command: "uvx",
          args: ["awslabs.aws-documentation-mcp-server@latest"],
          env: { FASTMCP_LOG_LEVEL: "ERROR" },
          disabled: false,
          autoApprove: ["search"],
        },
      },
    });
    const servers = parseMcpConfig(text, "workspace");
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      id: "aws-docs",
      transport: "stdio",
      command: "uvx",
      args: ["awslabs.aws-documentation-mcp-server@latest"],
      env: { FASTMCP_LOG_LEVEL: "ERROR" },
      autoApprove: ["search"],
      disabled: false,
      scope: "workspace",
    });
  });

  it("parses url-based (sse/http) servers", () => {
    const text = JSON.stringify({
      mcpServers: {
        remote: { url: "https://mcp.example.com/sse" },
        streamed: { type: "http", url: "https://mcp.example.com/stream" },
      },
    });
    const servers = parseMcpConfig(text, "user");
    expect(servers.find((s) => s.id === "remote")?.transport).toBe("sse");
    expect(servers.find((s) => s.id === "streamed")?.transport).toBe("http");
  });

  it("accepts JSONC (comments + trailing commas)", () => {
    const text = `{
      // my servers
      "mcpServers": {
        "x": { "command": "node", "args": ["server.js"], },
      },
    }`;
    expect(parseMcpConfig(text, "workspace")).toHaveLength(1);
  });

  it("drops invalid servers (no command and no url) and bad JSON", () => {
    const text = JSON.stringify({ mcpServers: { broken: { args: ["x"] } } });
    expect(parseMcpConfig(text, "workspace")).toEqual([]);
    expect(parseMcpConfig("not json", "workspace")).toEqual([]);
    expect(parseMcpConfig(JSON.stringify({ nope: {} }), "user")).toEqual([]);
  });
});

describe("mergeMcpServers", () => {
  it("workspace overrides user by id and sorts by id", () => {
    const user = parseMcpConfig(
      JSON.stringify({ mcpServers: { a: { command: "u" }, z: { command: "u" } } }),
      "user",
    );
    const workspace = parseMcpConfig(
      JSON.stringify({ mcpServers: { a: { command: "w" } } }),
      "workspace",
    );
    const merged = mergeMcpServers(user, workspace);
    expect(merged.map((s) => s.id)).toEqual(["a", "z"]);
    expect(merged.find((s) => s.id === "a")).toMatchObject({ command: "w", scope: "workspace" });
  });
});

describe("loadMcpServers + isToolAutoApproved", () => {
  it("loads from both texts and reports auto-approval", () => {
    const userText = JSON.stringify({ mcpServers: { u: { command: "x" } } });
    const wsText = JSON.stringify({
      mcpServers: { w: { command: "y", autoApprove: ["safe"] } },
    });
    const servers = loadMcpServers(userText, wsText);
    expect(servers.map((s) => s.id)).toEqual(["u", "w"]);
    const w = servers.find((s) => s.id === "w")!;
    expect(isToolAutoApproved(w, "safe")).toBe(true);
    expect(isToolAutoApproved(w, "danger")).toBe(false);
  });

  it("handles null inputs", () => {
    expect(loadMcpServers(null, null)).toEqual([]);
  });
});
