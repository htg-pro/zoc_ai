/** Feature: zoc-agent-chat-rebuild, task 31.2 (R27.1, R27.2, R27.3). */
import { formatCostCents, formatTokens } from "./usage-figures";
import type { SessionUsageTotals } from "./session-usage";

export function SessionUsageSummary({ usage }: { usage: SessionUsageTotals }) {
  if (usage.runCount === 0) return null;
  const cost = formatCostCents(usage.estimatedCostCents);
  const percent = Math.round(usage.contextProportion * 100);
  return (
    <div
      className="flex flex-wrap items-center gap-2 px-4 py-1 font-mono"
      data-zoc-session-usage=""
      aria-label={`Session usage: ${String(usage.inputTokens)} input tokens, ${String(usage.outputTokens)} output tokens, estimated cost ${cost ?? "unavailable"}, context ${String(percent)} percent`}
      style={{ color: "var(--zoc-text-faint)", fontSize: "var(--zoc-text-label)" }}
    >
      <span>Session total</span>
      <span>· {formatTokens(usage.inputTokens)} in</span>
      <span>· {formatTokens(usage.outputTokens)} out</span>
      {cost === null ? null : <span>· {cost}</span>}
      <span data-zoc-context-proportion={String(usage.contextProportion)}>
        · {percent}% context
      </span>
    </div>
  );
}
