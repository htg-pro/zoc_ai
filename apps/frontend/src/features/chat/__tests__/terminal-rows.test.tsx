/**
 * The terminal and fallback rows — zoc-agent-chat-rebuild task 16.3.
 *
 * R13.10 (Token_Rate on the usage row, omitted when null), R16.6 (code, message, retry),
 * R23.2 (a neutral historical row rather than a failure), R7.6 (a neutral unknown row),
 * R27.1 (per-Run token counts and cost), R34.3 / R34.6 / R34.7 (the compaction record,
 * in position, read-only).
 *
 * Property 3 owns the unknown-discriminant *arithmetic* and lives in its own file; what is
 * asserted here is what each row puts on screen, plus the two pure models behind them.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { CompactionPart, UsagePart } from "@zoc-studio/shared-types";

import { CompactionRow } from "@/features/chat/CompactionRow";
import { ErrorRow } from "@/features/chat/ErrorRow";
import { HistoricalRow } from "@/features/chat/HistoricalRow";
import { UnknownPartRow } from "@/features/chat/UnknownPartRow";
import { UsageRow } from "@/features/chat/UsageRow";
import {
  collapseHistorical,
  formatHistoricalRaw,
  type HistoricalEvent,
} from "@/features/chat/historical-rows";
import {
  formatCostCents,
  formatTokenRate,
  formatTokens,
  usageFiguresOf,
} from "@/features/chat/usage-figures";

afterEach(cleanup);

// ── Fixtures ──────────────────────────────────────────────────────────

const usage = (overrides: Partial<UsagePart> = {}): UsagePart => ({
  type: "usage",
  seq: 12,
  runId: "run_1",
  messageId: "msg_1",
  ts: "2026-07-31T10:00:00.000Z",
  inputTokens: 12_431,
  outputTokens: 843,
  reasoningTokens: 0,
  cachedInputTokens: 0,
  contextLimit: 200_000,
  estimatedCostCents: 4.2,
  tokensPerSecond: 24.66,
  messagesInContext: 8,
  sessionMessageCount: 8,
  messagesOutOfWindow: 0,
  summaryActive: false,
  ...overrides,
});

const compaction = (overrides: Partial<CompactionPart> = {}): CompactionPart => ({
  type: "compaction",
  seq: 3,
  runId: "run_1",
  messageId: "msg_1",
  ts: "2026-07-31T10:00:00.000Z",
  compactionId: "cmp_1",
  foldedMessageIds: ["msg_a", "msg_b", "msg_c"],
  foldedTurnCount: 3,
  contextTokensBefore: 48_200,
  contextTokensAfter: 6_100,
  summary: "The user asked for a parser; we shipped it and its tests.",
  ...overrides,
});

const historical = (overrides: Partial<HistoricalEvent> = {}): HistoricalEvent => ({
  id: "hist_1",
  runId: "run_1",
  seq: 1,
  kind: "test-results",
  label: "Test results",
  ts: "2026-07-31T10:00:00.000Z",
  raw: { type: "test-results", passed: 12, failed: 0 },
  ...overrides,
});

// ── ErrorRow (R16.6) ──────────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, 16.3 ErrorRow renders R16.6's three things", () => {
  it("renders the code and the human message", () => {
    render(
      <ErrorRow
        error={{
          code: "provider_rate_limited",
          message: "The provider is rate limiting this key.",
          retryable: true,
        }}
      />,
    );
    expect(screen.getByText("provider_rate_limited")).toBeInTheDocument();
    expect(screen.getByText("The provider is rate limiting this key.")).toBeInTheDocument();
  });

  it("offers retry exactly when the flag is true and a handler exists", () => {
    const onRetry = vi.fn();
    const { unmount } = render(
      <ErrorRow
        error={{ code: "workspace_unavailable", message: "Retry me.", retryable: true }}
        onRetry={onRetry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();

    render(
      <ErrorRow
        error={{ code: "internal", message: "No retry.", retryable: false }}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("withholds retry when the flag is absent, because absent means no retry", () => {
    render(
      <ErrorRow error={{ code: "internal", message: "Unclassified." }} onRetry={() => undefined} />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("never offers retry for a cancellation, whatever the flag says", () => {
    render(
      <ErrorRow
        error={{ code: "run_cancelled", message: "Stopped.", retryable: true }}
        onRetry={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("normalises a runtime error nested under `envelope`, which is the shape 16.2 recovered", () => {
    const wrapped = Object.assign(new Error("Request failed with status 429"), {
      envelope: {
        code: "provider_rate_limited",
        message: "Too many requests for this key right now.",
        details: "status 429",
        retryable: true,
      },
    });
    render(<ErrorRow error={wrapped} onRetry={() => undefined} />);
    expect(screen.getByText("provider_rate_limited")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("discloses `details` only when there are some", () => {
    const { unmount } = render(
      <ErrorRow
        error={{ code: "internal", message: "Failed.", details: "at boundary", retryable: false }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText("at boundary")).toBeInTheDocument();
    unmount();

    render(<ErrorRow error={{ code: "internal", message: "Failed.", retryable: false }} />);
    expect(screen.queryByRole("button", { name: /details/i })).toBeNull();
  });
});

// ── UsageRow and its figures (R13.10, R27.1) ──────────────────────────

describe("Feature: zoc-agent-chat-rebuild, 16.3 UsageRow omits an absent figure rather than zeroing it", () => {
  it("shows tokens in and out, the cost, the model, and the rate (R27.1, R13.10)", () => {
    render(<UsageRow usage={usage()} model="claude-opus-5" />);
    expect(screen.getByText("12.4k in")).toBeInTheDocument();
    expect(screen.getByText("843 out")).toBeInTheDocument();
    expect(screen.getByText("4.2¢")).toBeInTheDocument();
    expect(screen.getByText("claude-opus-5")).toBeInTheDocument();
    expect(screen.getByText("24.7 tok/s")).toBeInTheDocument();
  });

  it("omits the Token_Rate figure entirely when it is null, rather than showing 0 (R13.10)", () => {
    const { container } = render(<UsageRow usage={usage({ tokensPerSecond: null })} model="m" />);
    expect(container.querySelector("[data-zoc-usage-figure='rate']")).toBeNull();
    expect(screen.queryByText(/tok\/s/)).toBeNull();
    // The rest of the line survives: an absent rate is not an absent row.
    expect(screen.getByText("843 out")).toBeInTheDocument();
  });

  it("omits the cost figure when the runtime estimated none", () => {
    const { container } = render(<UsageRow usage={usage({ estimatedCostCents: null })} />);
    expect(container.querySelector("[data-zoc-usage-figure='cost']")).toBeNull();
  });

  it("omits the model when the caller has none, so the line never shows an empty cell", () => {
    const { container } = render(<UsageRow usage={usage()} />);
    expect(container.querySelector("[data-zoc-usage-figure='model']")).toBeNull();
  });

  it("names every shown figure in speech rather than punctuation", () => {
    const { container } = render(<UsageRow usage={usage()} model="claude-opus-5" />);
    const label = container.querySelector("[data-zoc-row='usage']")?.getAttribute("aria-label");
    expect(label).toBe(
      "Run usage: 12.4k input tokens, 843 output tokens, estimated cost 4.2¢, model claude-opus-5, 24.7 tokens per second",
    );
  });

  it("formats token counts exactly below a thousand and abbreviated above, with no trailing zero", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(12_431)).toBe("12.4k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
    // A negative or non-finite count is a bug upstream; it reads as zero rather than as `NaN`.
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });

  it("formats cost in cents below a dollar and dollars above, and refuses an absent one", () => {
    expect(formatCostCents(0)).toBe("0¢");
    expect(formatCostCents(4.2)).toBe("4.2¢");
    expect(formatCostCents(99.94)).toBe("99.9¢");
    expect(formatCostCents(123)).toBe("$1.23");
    expect(formatCostCents(null)).toBeNull();
    expect(formatCostCents(undefined)).toBeNull();
  });

  it("formats a rate with one decimal below a hundred and refuses zero, null, and non-finite", () => {
    expect(formatTokenRate(4.24)).toBe("4.2 tok/s");
    expect(formatTokenRate(24.66)).toBe("24.7 tok/s");
    expect(formatTokenRate(132.4)).toBe("132 tok/s");
    expect(formatTokenRate(null)).toBeNull();
    expect(formatTokenRate(undefined)).toBeNull();
    // Zero is the case R13.10 is about: a Run that generated nothing has no rate, not a rate of 0.
    expect(formatTokenRate(0)).toBeNull();
    expect(formatTokenRate(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("keeps the figure order stable, so the line does not reflow between Runs", () => {
    const keys = usageFiguresOf(usage(), "m").map((figure) => figure.key);
    expect(keys).toEqual(["input", "output", "cost", "model", "rate"]);
  });
});

// ── CompactionRow (R34.3, R34.6, R34.7) ───────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, 16.3 CompactionRow is a record, not a banner", () => {
  it("collapses to one line naming the folded turns and the token figures (R34.3)", () => {
    const { container } = render(<CompactionRow compaction={compaction()} />);
    expect(screen.getByText("Folded 3 earlier turns")).toBeInTheDocument();
    expect(screen.getByText("48.2k → 6.1k tokens")).toBeInTheDocument();
    // Collapsed: neither the turn list nor the summary is reachable yet.
    expect(container.querySelector("[data-zoc-compaction-turns]")).toBeNull();
    expect(screen.queryByText(compaction().summary)).toBeNull();
  });

  it("is complete to a screen reader while collapsed", () => {
    const { container } = render(<CompactionRow compaction={compaction()} />);
    expect(
      container.querySelector("[data-zoc-compaction-trigger]")?.getAttribute("aria-label"),
    ).toBe("Folded 3 earlier turns, 48.2k → 6.1k tokens");
  });

  it("reveals the folded turn list and the summary on expansion (R34.3)", () => {
    render(<CompactionRow compaction={compaction()} />);
    fireEvent.click(screen.getByRole("button", { name: /Folded 3 earlier turns/ }));
    for (const id of compaction().foldedMessageIds) {
      expect(screen.getByText(id)).toBeInTheDocument();
    }
    expect(screen.getByText(compaction().summary)).toBeInTheDocument();
  });

  it("presents the summary read-only, with no edit affordance at all (R34.7)", () => {
    const { container } = render(<CompactionRow compaction={compaction()} />);
    fireEvent.click(screen.getByRole("button", { name: /Folded 3 earlier turns/ }));
    const summary = container.querySelector("[data-zoc-compaction-summary]");
    expect(summary?.tagName).toBe("P");
    expect(summary?.getAttribute("contenteditable")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("says `turn` for one folded turn, because `1 turns` is the case a template forgets", () => {
    render(
      <CompactionRow
        compaction={compaction({ foldedTurnCount: 1, foldedMessageIds: ["msg_a"] })}
      />,
    );
    expect(screen.getByText("Folded 1 earlier turn")).toBeInTheDocument();
  });

  it("uses the caller's resolver for a folded turn's label, falling back to the id", () => {
    render(
      <CompactionRow
        compaction={compaction({ foldedMessageIds: ["msg_a", "msg_b"] })}
        resolveFoldedTurn={(id) => (id === "msg_a" ? "You: add a parser" : undefined)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Folded 3 earlier turns/ }));
    expect(screen.getByText("You: add a parser")).toBeInTheDocument();
    expect(screen.getByText("msg_b")).toBeInTheDocument();
  });
});

// ── HistoricalRow and its collapsing (R23.2) ──────────────────────────

describe("Feature: zoc-agent-chat-rebuild, 16.3 HistoricalRow preserves a legacy event", () => {
  it("shows the italic label and the time, and the raw record on expansion", () => {
    const { container } = render(<HistoricalRow item={{ kind: "event", event: historical() }} />);
    const label = container.querySelector("[data-zoc-historical-label]");
    expect(label?.textContent).toBe("Test results");
    expect(label?.className).toContain("italic");
    expect(container.querySelector("[data-zoc-historical-time]")?.textContent).not.toBe("");

    expect(container.querySelector("[data-zoc-historical-raw='hist_1']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Test results/ }));
    expect(container.querySelector("[data-zoc-historical-raw='hist_1']")?.textContent).toBe(
      formatHistoricalRaw(historical().raw),
    );
  });

  it("drops an unparseable timestamp rather than the row", () => {
    const { container } = render(
      <HistoricalRow item={{ kind: "event", event: historical({ ts: "not a date" }) }} />,
    );
    expect(container.querySelector("[data-zoc-historical-time]")).toBeNull();
    expect(container.querySelector("[data-zoc-historical-label]")?.textContent).toBe(
      "Test results",
    );
  });

  it("shows a count and every member's record for a collapsed stage run", () => {
    const members = [
      historical({ id: "s1", kind: "stage", label: "Stage: INTAKE", raw: { stage: "INTAKE" } }),
      historical({ id: "s2", kind: "stage", label: "Stage: ANALYZE", raw: { stage: "ANALYZE" } }),
      historical({
        id: "s3",
        kind: "stage",
        label: "Stage: APPLY_EDITS",
        raw: { stage: "APPLY_EDITS" },
      }),
    ];
    const { container } = render(
      <HistoricalRow item={{ kind: "stage-run", runId: "run_1", latest: members[2]!, members }} />,
    );
    // The *last* stage reached is the one worth showing.
    expect(container.querySelector("[data-zoc-historical-label]")?.textContent).toBe(
      "Stage: APPLY_EDITS",
    );
    expect(container.querySelector("[data-zoc-historical-collapsed]")?.textContent).toContain("3");

    fireEvent.click(screen.getByRole("button", { name: /Stage: APPLY_EDITS/ }));
    for (const member of members) {
      expect(container.querySelector(`[data-zoc-historical-raw='${member.id}']`)).not.toBeNull();
    }
  });
});

describe("Feature: zoc-agent-chat-rebuild, 16.3 collapseHistorical folds consecutive same-Run stages", () => {
  const stage = (id: string, runId = "run_1") =>
    historical({ id, runId, kind: "stage", label: `Stage: ${id}` });

  it("folds a consecutive run into one item and leaves other kinds alone", () => {
    const items = collapseHistorical([
      historical({ id: "r1", kind: "review", label: "Code review report" }),
      stage("a"),
      stage("b"),
      stage("c"),
      historical({ id: "t1", kind: "test-results", label: "Test results" }),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["event", "stage-run", "event"]);
    expect(items[1]).toMatchObject({ kind: "stage-run", runId: "run_1" });
  });

  it("breaks the fold at a Run boundary, because two Runs' stages are two progressions", () => {
    const items = collapseHistorical([
      stage("a"),
      stage("b"),
      stage("c", "run_2"),
      stage("d", "run_2"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "stage-run", runId: "run_1" });
    expect(items[1]).toMatchObject({ kind: "stage-run", runId: "run_2" });
  });

  it("never merges non-adjacent stages, because the ordering between them is the record", () => {
    const items = collapseHistorical([
      stage("a"),
      historical({ id: "t1", kind: "test-results", label: "Test results" }),
      stage("b"),
    ]);
    expect(items.map((item) => item.kind)).toEqual(["event", "event", "event"]);
  });

  it("leaves a lone stage as an ordinary event, so no row shows a count of one", () => {
    const items = collapseHistorical([stage("a")]);
    expect(items).toEqual([{ kind: "event", event: stage("a") }]);
  });

  it("preserves the caller's order and never sorts", () => {
    const events = [
      historical({ id: "b", seq: 9, label: "Run summary", kind: "summary" }),
      historical({ id: "a", seq: 1, label: "Test results" }),
    ];
    const items = collapseHistorical(events);
    expect(items.map((item) => (item.kind === "event" ? item.event.id : item.runId))).toEqual([
      "b",
      "a",
    ]);
  });

  it("renders a record that cannot be serialised rather than throwing", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => formatHistoricalRaw(cyclic)).not.toThrow();
    expect(formatHistoricalRaw(undefined)).toBe("undefined");
  });
});

// ── UnknownPartRow (R7.6) ─────────────────────────────────────────────

describe("Feature: zoc-agent-chat-rebuild, 16.3 UnknownPartRow is neutral and inert", () => {
  it("names the discriminant it could not render (R7.6)", () => {
    const { container } = render(<UnknownPartRow discriminant="zoc-telepathy" />);
    expect(
      container.querySelector("[data-zoc-unknown-discriminant='zoc-telepathy']"),
    ).not.toBeNull();
    expect(container.textContent).toContain("Unrecognised event");
    expect(container.textContent).toContain("zoc-telepathy");
  });

  it("offers nothing to act on, because no action changes a version skew", () => {
    const { container } = render(<UnknownPartRow discriminant="zoc-telepathy" />);
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    // Not an error row: nothing failed, so nothing is drawn in the error colour.
    expect(container.innerHTML).not.toContain("--zoc-error");
  });
});
