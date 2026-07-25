import { test, expect } from "vitest";
import { render } from "@testing-library/react";
import type { AgentEvents } from "@zoc-studio/shared-types";
import { CommandRow } from "../rows";

const base: AgentEvents.CommandEvent = {
  type: "command",
  seq: 1,
  runId: "r",
  ts: "2026-01-01T00:00:00Z",
  command: "mcp::web-search::web_search",
};

// R12.6/R12.7: an MCP command row shows an "MCP" badge with the owning server id.
test("CommandRow renders the MCP badge when mcpServerId is present", () => {
  const { container } = render(<CommandRow event={{ ...base, mcpServerId: "web-search" }} />);
  const badge = container.querySelector('[data-mcp-badge="web-search"]');
  expect(badge).toBeTruthy();
  expect(container.textContent).toContain("MCP");
});

test("CommandRow renders no MCP badge when mcpServerId is absent", () => {
  const { container } = render(<CommandRow event={{ ...base, command: "npm test" }} />);
  expect(container.querySelector("[data-mcp-badge]")).toBeNull();
});
