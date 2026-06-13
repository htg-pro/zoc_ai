import { useState } from "react";
import { Loader2, MoreVertical, RefreshCcw, Scissors, Trash2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import { useApp } from "@/lib/store";

/**
 * Kebab menu for the agent panel header. Surfaces the Phase-5 memory
 * controls — reload from server (recovers from desync), compact (force
 * summarisation now), and forget (drop summary + recall, keep canonical
 * messages).
 */
export function AgentMenu() {
  const liveMode = useApp((s) => s.liveMode);
  const activeSessionId = useApp((s) => s.activeSessionId);
  const selectSession = useApp((s) => s.selectSession);
  const compactMemory = useApp((s) => s.compactMemory);
  const forgetMemory = useApp((s) => s.forgetMemory);
  const [busy, setBusy] = useState<null | "reload" | "compact" | "forget">(null);

  const onReload = async () => {
    if (!liveMode || busy) return;
    setBusy("reload");
    try {
      await selectSession(activeSessionId);
      toast.success("Conversation reloaded");
    } finally {
      setBusy(null);
    }
  };

  const onCompact = async () => {
    if (!liveMode || busy) return;
    setBusy("compact");
    try {
      await compactMemory();
      toast.success("Older turns compacted into summary");
    } finally {
      setBusy(null);
    }
  };

  const onForget = async () => {
    if (!liveMode || busy) return;
    setBusy("forget");
    try {
      await forgetMemory();
      toast.message("Memory cleared", {
        description: "Summary and recall index removed. Conversation log kept.",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-border bg-background hover:bg-accent disabled:opacity-50"
          aria-label="Conversation memory"
          disabled={!liveMode}
          title={liveMode ? "Memory actions" : "Memory actions (sidecar offline)"}
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <MoreVertical className="h-3.5 w-3.5" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>Conversation memory</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void onReload();
          }}
          disabled={busy !== null}
        >
          <RefreshCcw className="mr-2 h-3.5 w-3.5" />
          Reload from server
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void onCompact();
          }}
          disabled={busy !== null}
        >
          <Scissors className="mr-2 h-3.5 w-3.5" />
          Compact older turns
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            void onForget();
          }}
          disabled={busy !== null}
          className="text-destructive focus:text-destructive"
        >
          <Trash2 className="mr-2 h-3.5 w-3.5" />
          Forget memory layers
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
