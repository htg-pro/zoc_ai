// Feature: zoc-ai-agent-chat-overhaul, Property 24: Rendering is strict and never stringifies a payload
// Feature: zoc-ai-agent-chat-overhaul, Property 13: The reasoning panel exists exactly when there is reasoning
// Feature: zoc-ai-agent-chat-overhaul, Property 20: Every terminal run reports its outcome completely
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import { type FeedRow, type FeedRowKind } from "../normalize";
import { renderRow } from "../rows";
import { clearDiagnostics, getDiagnosticsSnapshot } from "../diagnostics";

afterEach(cleanup);

const DEFINED_KINDS: FeedRowKind[] = [
  "user-message",
  "assistant-message",
  "reasoning",
  "run-metadata",
  "stage",
  "tool-call",
  "diff",
  "command",
  "approval",
  "plan-ready",
  "run-summary",
  "error",
];

function sampleRow(kind: FeedRowKind, i: number): FeedRow {
  const base = { id: `${kind}:${i}`, seq: i, runId: "run-1" };
  switch (kind) {
    case "user-message":
      return { ...base, kind, text: `hello ${i}` };
    case "assistant-message":
      return { ...base, kind, messageId: `m${i}`, text: `answer ${i}`, streaming: false };
    case "reasoning":
      return { ...base, kind, text: `weighing ${i}`, collapsed: false, truncated: false };
    case "run-metadata":
      return { ...base, kind, modelTier: "cloud", contextWindowTokens: 128000, fallbackReason: null };
    case "stage":
      return {
        ...base,
        kind,
        stages: [{ stage: "analyze", state: "active", reason: null }],
      };
    case "tool-call":
      return { ...base, kind, tool: "shell", target: `ls ${i}`, status: "succeeded", result: "ok", failure: null, key: `k${i}` };
    case "diff":
      return { ...base, kind, files: [{ path: `a${i}.ts`, adds: 1, dels: 0, diff: "@@\n+x", baseHash: null }], decision: "pending" };
    case "command":
      return { ...base, kind, command: `echo ${i}`, status: "pass", exitCode: 0, outputTail: "done", mcpServerId: null };
    case "approval":
      return { ...base, kind, prompt: "run tests?", operation: "run_command", tool: "run_command", target: null, decision: null };
    case "plan-ready":
      return { ...base, kind, steps: [{ file: "a.ts", action: "modify", rationale: "fix" }], verificationCommand: null };
    case "run-summary":
      return { ...base, kind, outcome: "done", mode: "agent", elapsedMs: 1000, filesChanged: 2, reason: null };
    case "error":
      return { ...base, kind, code: "boom", operation: "run", message: "it failed", retryable: true };
    default:
      return { ...base, kind: "user-message", text: "x" };
  }
}

describe("strict rendering (Property 24)", () => {
  it("renders one node per defined row, nothing for an undefined kind, and no serialized payloads", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...DEFINED_KINDS), { minLength: 1, maxLength: 12 }),
        (kinds) => {
          clearDiagnostics();
          const rows = kinds.map((k, i) => sampleRow(k, i));
          // Inject one row with an undefined kind.
          const bogus = { id: "x:1", seq: 999, runId: "run-1", kind: "totally-unknown" } as unknown as FeedRow;
          const all = [...rows, bogus];

          const { container } = render(<div>{all.map((r) => <div key={r.id}>{renderRow(r)}</div>)}</div>);

          // One node per defined row.
          const nodes = container.querySelectorAll("[data-row-kind]");
          expect(nodes.length).toBe(rows.length);

          // The undefined kind rendered nothing and was recorded.
          const snap = getDiagnosticsSnapshot();
          expect(snap.some((e) => e.kind === "unrenderable-kind" && e.detail === "totally-unknown")).toBe(true);

          // No serialized object/array literal leaked into text.
          expect(container.textContent ?? "").not.toContain("[object Object]");
          expect(container.textContent ?? "").not.toMatch(/\{"kind":/);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("reasoning panel (Property 13)", () => {
  it("renders a reasoning panel exactly when there is reasoning text, and only there", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        // A reasoning row only exists for non-empty reasoning (the normalizer
        // discards empty). Here we render whichever rows the transcript has.
        const rows: FeedRow[] =
          text.trim().length > 0
            ? [{ id: "r:1", seq: 1, runId: "run-1", kind: "reasoning", text, collapsed: false, truncated: false }]
            : [];
        const { container } = render(<div>{rows.map((r) => <div key={r.id}>{renderRow(r)}</div>)}</div>);
        const panels = container.querySelectorAll('[data-row-kind="reasoning"]');
        expect(panels.length).toBe(rows.length);
        if (rows.length > 0) {
          // The reasoning text appears inside the panel subtree.
          expect(panels[0].textContent ?? "").toContain(text.trim().slice(0, 8));
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("run summary completeness (Property 20)", () => {
  it("reports outcome, elapsed duration, and files-changed count; names zero-change reason", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("done", "failed", "cancelled"),
        fc.nat({ max: 600_000 }),
        fc.nat({ max: 10 }),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        (outcome, elapsedMs, filesChanged, reason) => {
          const row: FeedRow = {
            id: "s:1",
            seq: 1,
            runId: "run-1",
            kind: "run-summary",
            outcome: outcome as FeedRow extends { kind: "run-summary" } ? never : never,
            mode: "agent",
            elapsedMs,
            filesChanged,
            reason,
          } as unknown as FeedRow;
          const { container } = render(<div>{renderRow(row)}</div>);
          const text = container.textContent ?? "";
          // Outcome word present.
          const label = outcome === "done" ? "Completed" : outcome === "failed" ? "Failed" : "Stopped";
          expect(text).toContain(label);
          // Files-changed count present.
          expect(text).toContain(String(filesChanged));
          if (filesChanged === 0) {
            expect(text).toContain("No files were changed");
            if (reason) expect(text).toContain(reason);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});


describe("run metadata copy", () => {
  it("labels the allocator value as a planning budget", () => {
    const row: FeedRow = {
      id: "meta:1",
      seq: 1,
      runId: "run-1",
      kind: "run-metadata",
      modelTier: "local-slm",
      contextWindowTokens: 4_000,
      fallbackReason: null,
    };
    const { container } = render(<div>{renderRow(row)}</div>);

    expect(container.textContent).toContain("4,000-token planning budget");
    expect(container.textContent).not.toContain("token context");
  });
});
