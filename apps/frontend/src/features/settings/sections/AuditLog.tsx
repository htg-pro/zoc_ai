import { useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clearAuditLog, getAuditLog, subscribeTrust, type AuditEntry } from "@/lib/trust";
import type { Effect } from "@/lib/permissions-engine";

const EFFECT_TONE: Record<Effect, string> = {
  allow: "text-[var(--zoc-success)]",
  deny: "text-[var(--zoc-error)]",
  prompt: "text-[var(--zoc-ember)]",
};

/**
 * Security → Audit Log (Part 7.1). Lists every permission decision recorded by
 * `trust.ts` (allow / deny / prompt) with its timestamp, action kind, name,
 * target, and reason. Newest first.
 */
export function AuditLogSection() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  useEffect(() => {
    setEntries([...getAuditLog()]);
    return subscribeTrust(() => setEntries([...getAuditLog()]));
  }, []);

  const rows = [...entries].reverse();

  return (
    <div className="space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
            <ShieldCheck className="h-4 w-4 text-[var(--zoc-info)]" />
            Audit Log
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every permission decision — allow, deny, or prompt — with its action and reason.
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => clearAuditLog()}
          disabled={rows.length === 0}
        >
          <Trash2 className="mr-1.5 h-3.5 w-3.5" />
          Clear
        </Button>
      </header>

      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No decisions recorded yet.</p>
      ) : (
        <div className="grid gap-1">
          {rows.map((e, i) => (
            <div
              key={i}
              data-audit-entry
              className="flex items-center gap-2 rounded border border-border bg-accent/30 px-2 py-1 text-xs"
            >
              <span className={`w-12 shrink-0 font-medium uppercase ${EFFECT_TONE[e.effect]}`}>
                {e.effect}
              </span>
              <span className="w-16 shrink-0 text-[10px] uppercase text-muted-foreground">
                {e.kind}
              </span>
              {e.runId && (
                <span
                  className="w-24 shrink-0 truncate font-mono text-[10px] text-muted-foreground"
                  title={e.runId}
                >
                  {e.runId}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-mono">{e.name}</span>
              {e.target && (
                <span className="min-w-0 max-w-[30%] truncate font-mono text-muted-foreground">
                  {e.target}
                </span>
              )}
              <span className="hidden shrink-0 text-muted-foreground sm:inline">{e.reason}</span>
              <time className="shrink-0 text-[10px] text-muted-foreground">
                {new Date(e.ts).toLocaleTimeString()}
              </time>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
