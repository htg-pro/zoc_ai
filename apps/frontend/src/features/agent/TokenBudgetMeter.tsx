import { useEffect, useRef } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";

import { toast } from "@/components/ui/toast";

const WARNING_THRESHOLD = 0.8;

export interface TokenBudgetMeterProps {
  active: boolean;
  budget: AgentEvents.BudgetEvent | null;
}

function meterColor(ratio: number): string {
  if (ratio >= WARNING_THRESHOLD) return "#f87171";
  if (ratio >= 0.6) return "#fbbf24";
  return "#4ade80";
}

export function TokenBudgetMeter({ active, budget }: TokenBudgetMeterProps) {
  const warnedRunId = useRef<string | null>(null);
  const limit = budget?.tokenLimit ?? 0;
  const used = budget?.tokensUsed ?? 0;
  const ratio = limit > 0 ? used / limit : 0;

  useEffect(() => {
    if (!active) {
      warnedRunId.current = null;
      return;
    }
    if (budget && ratio >= WARNING_THRESHOLD && warnedRunId.current !== budget.runId) {
      warnedRunId.current = budget.runId;
      toast.warning("Token budget is 80% consumed");
    }
  }, [active, budget, ratio]);

  if (!active || !budget || limit <= 0) return null;

  const percentage = Math.min(Math.max(ratio * 100, 0), 100);
  const title = `${used.toLocaleString()} / ${limit.toLocaleString()} tokens used · ${budget.iterations} iterations · ${budget.recoveries} recoveries`;

  return (
    <div
      className="h-[2px] w-full bg-[#1A1A1F]"
      data-testid="token-budget-meter"
      title={title}
    >
      <div
        className="h-full transition-[width,background-color] duration-300 ease-out"
        role="progressbar"
        aria-label="Token budget used"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        style={{ width: `${percentage}%`, backgroundColor: meterColor(ratio) }}
      />
    </div>
  );
}
