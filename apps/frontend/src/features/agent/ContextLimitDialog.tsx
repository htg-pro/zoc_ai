import { AlertTriangle, Scissors, ArrowRightLeft, X } from "lucide-react";
import { useState } from "react";
import type { ContextStatus } from "@zoc-studio/shared-types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";
import { toast } from "@/components/ui/toast";

function cn(...classes: (string | boolean | undefined)[]) {
  return classes.filter(Boolean).join(" ");
}

interface ContextLimitDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contextStatus: ContextStatus;
}

/**
 * Dialog shown when context limit is reached or approaching.
 * Offers options to:
 * - Compact context (summarize old messages)
 * - Switch to larger model (if available)
 * - Continue anyway (if possible)
 */
export function ContextLimitDialog({
  open,
  onOpenChange,
  contextStatus,
}: ContextLimitDialogProps) {
  const compactMemory = useApp((s) => s.compactMemory);
  const setSelectedModel = useApp((s) => s.setSelectedModel);
  const [loading, setLoading] = useState<"compact" | "switch" | null>(null);

  const handleCompact = async () => {
    setLoading("compact");
    try {
      await compactMemory();
      toast.success("Context compacted successfully");
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to compact context");
    } finally {
      setLoading(null);
    }
  };

  const handleSwitchModel = async () => {
    if (!contextStatus.recommended_model) return;
    
    setLoading("switch");
    try {
      // Parse provider from recommended model (format: "provider/model")
      const parts = contextStatus.recommended_model.split("/");
      const provider = parts.length > 1 ? parts[0] : contextStatus.model.split("/")[0];
      const model = parts.length > 1 ? parts[1] : contextStatus.recommended_model;
      
      setSelectedModel({ provider, model });
      toast.success(`Switched to ${contextStatus.recommended_model}`);
      onOpenChange(false);
    } catch (error) {
      toast.error("Failed to switch model");
    } finally {
      setLoading(null);
    }
  };

  const usagePercent = Math.round(contextStatus.usage_percent);
  const isCritical = usagePercent >= 95;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className={cn(
              "h-5 w-5",
              isCritical ? "text-red-500" : "text-yellow-500"
            )} />
            {isCritical ? "Context Limit Reached" : "Context Limit Approaching"}
          </DialogTitle>
          <DialogDescription>
            {isCritical
              ? "You've reached the context limit. Choose an option to continue."
              : `You're using ${usagePercent}% of the available context. Consider freeing up space.`}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          <div className="text-sm text-muted-foreground">
            <div className="flex justify-between mb-1">
              <span>Current usage:</span>
              <span className="font-medium">
                {contextStatus.tokens_used.toLocaleString()} / {contextStatus.context_window.toLocaleString()} tokens
              </span>
            </div>
            <div className="flex justify-between">
              <span>Model:</span>
              <span className="font-medium">{contextStatus.model}</span>
            </div>
          </div>

          <div className="space-y-2">
            {contextStatus.compaction_available && (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={handleCompact}
                disabled={loading !== null}
              >
                <Scissors className="mr-2 h-4 w-4" />
                Compact Context
                {loading === "compact" && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    (summarizing...)
                  </span>
                )}
              </Button>
            )}

            {contextStatus.recommended_model && (
              <Button
                variant="outline"
                className="w-full justify-start"
                onClick={handleSwitchModel}
                disabled={loading !== null}
              >
                <ArrowRightLeft className="mr-2 h-4 w-4" />
                Switch to {contextStatus.recommended_model}
                {loading === "switch" && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    (switching...)
                  </span>
                )}
              </Button>
            )}

            {!isCritical && (
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => onOpenChange(false)}
                disabled={loading !== null}
              >
                Continue Anyway
              </Button>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={loading !== null}
          >
            <X className="mr-2 h-4 w-4" />
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
