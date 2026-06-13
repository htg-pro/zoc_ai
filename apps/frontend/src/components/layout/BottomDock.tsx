import { Terminal as TerminalIcon, AlertTriangle, ScrollText, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TerminalPane } from "@/features/terminal/TerminalPane";
import { ProblemsPanel } from "@/features/problems/ProblemsPanel";
import { LogsPanel } from "@/features/problems/LogsPanel";
import { useApp, type BottomTab } from "@/lib/store";
import { cn } from "@/lib/utils";

const TABS: { key: BottomTab; label: string; icon: typeof TerminalIcon }[] = [
  { key: "terminal", label: "Terminal", icon: TerminalIcon },
  { key: "problems", label: "Problems", icon: AlertTriangle },
  { key: "logs", label: "Logs", icon: ScrollText },
];

export function BottomDock() {
  const tab = useApp((s) => s.bottomTab);
  const setTab = useApp((s) => s.setBottomTab);
  const toggle = useApp((s) => s.toggleBottom);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-card/60 px-2">
        <div className="flex items-center gap-0.5" role="tablist" aria-label="Bottom dock">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                role="tab"
                aria-selected={active}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded px-2 text-xs transition-colors",
                  active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={toggle} aria-label="Close dock">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === "terminal" && <TerminalPane />}
        {tab === "problems" && <ProblemsPanel />}
        {tab === "logs" && <LogsPanel />}
      </div>
    </div>
  );
}
