// Feature: zoc-ai-agent-chat-overhaul, Task 12.8: the single-seam structural guard
//
// The strict Chat_Renderer (`rows.tsx`) must consume `FeedRow` only — never the
// SSE stream or the wire event types — so the Event_Normalizer is the sole path
// an Agent_Event reaches the renderer (R9.6). This asserts that structurally and
// that the ESLint `no-restricted-imports` guard is configured to enforce it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(rel: string): string {
  return readFileSync(path.resolve(ROOT, rel), "utf-8");
}

describe("renderer seam (Task 12.8)", () => {
  it("rows.tsx imports no stream or wire-event module", () => {
    const source = read("src/features/agent/rows.tsx");
    // No SSE stream / ingest imports.
    expect(source).not.toMatch(/from\s+["'][^"']*useAgentStream["']/);
    expect(source).not.toMatch(/from\s+["'][^"']*event-ingest["']/);
    // No wire-event union import.
    expect(source).not.toMatch(/from\s+["']@zoc-studio\/shared-types["']/);
  });

  it("the legacy event-based decision rows live outside the renderer", () => {
    const decision = read("src/features/agent/decision-rows.tsx");
    expect(decision).toMatch(/export function ApprovalRow/);
    expect(decision).toMatch(/export function PlanReadyRow/);
  });

  it("an ESLint no-restricted-imports guard is configured for the renderer", () => {
    const config = read("eslint.config.js");
    expect(config).toContain("no-restricted-imports");
    expect(config).toContain("src/features/agent/rows.tsx");
    expect(config).toContain("useAgentStream");
  });
});
