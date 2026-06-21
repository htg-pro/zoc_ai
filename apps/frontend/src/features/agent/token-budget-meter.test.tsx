import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { toast } from "@/components/ui/toast";
import { TokenBudgetMeter } from "./TokenBudgetMeter";

vi.mock("@/components/ui/toast", () => ({
  toast: { warning: vi.fn() },
}));

function budget(overrides: Partial<AgentEvents.BudgetEvent> = {}): AgentEvents.BudgetEvent {
  return {
    type: "budget",
    seq: 1,
    runId: "run-1",
    ts: "2026-06-21T00:00:00Z",
    tokensUsed: 2_000,
    tokenLimit: 4_000,
    iterations: 3,
    recoveries: 1,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TokenBudgetMeter", () => {
  it("renders only while active and exposes the complete hover summary", () => {
    const { queryByTestId, rerender } = render(
      <TokenBudgetMeter active={false} budget={budget()} />,
    );
    expect(queryByTestId("token-budget-meter")).toBeNull();

    rerender(<TokenBudgetMeter active budget={budget()} />);
    const meter = queryByTestId("token-budget-meter");
    expect(meter).toHaveAttribute(
      "title",
      "2,000 / 4,000 tokens used · 3 iterations · 1 recoveries",
    );
    expect(meter?.querySelector('[role="progressbar"]')).toHaveStyle({ width: "50%" });
  });

  it("moves from green to amber to red as usage increases", () => {
    const { getByRole, rerender } = render(
      <TokenBudgetMeter active budget={budget({ tokensUsed: 2_000 })} />,
    );
    expect(getByRole("progressbar")).toHaveStyle({ backgroundColor: "#4ade80" });

    rerender(<TokenBudgetMeter active budget={budget({ tokensUsed: 2_600 })} />);
    expect(getByRole("progressbar")).toHaveStyle({ backgroundColor: "#fbbf24" });

    rerender(<TokenBudgetMeter active budget={budget({ tokensUsed: 3_200 })} />);
    expect(getByRole("progressbar")).toHaveStyle({ backgroundColor: "#f87171" });
  });

  it("warns once per run when usage reaches 80 percent", () => {
    const { rerender } = render(
      <TokenBudgetMeter active budget={budget({ tokensUsed: 3_100 })} />,
    );
    expect(toast.warning).not.toHaveBeenCalled();

    rerender(<TokenBudgetMeter active budget={budget({ tokensUsed: 3_200, seq: 2 })} />);
    rerender(<TokenBudgetMeter active budget={budget({ tokensUsed: 3_600, seq: 3 })} />);
    expect(toast.warning).toHaveBeenCalledTimes(1);

    rerender(
      <TokenBudgetMeter
        active
        budget={budget({ runId: "run-2", tokensUsed: 3_200, seq: 1 })}
      />,
    );
    expect(toast.warning).toHaveBeenCalledTimes(2);
  });
});
