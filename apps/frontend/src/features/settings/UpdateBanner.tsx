import { useCallback, useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  checkForUpdate,
  dismissUpdate,
  installUpdate,
  isDismissed,
  openReleaseNotes,
  type AvailableUpdate,
} from "@/lib/auto-update";

/**
 * Update notification bar (§11.3).
 *
 * A slim bar at the top of the app rather than a modal: an available update is
 * information, not an interruption. "Later" hides it for 24 h.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((found) => {
      if (cancelled || !found) return;
      if (isDismissed(found.version, Date.now(), window.localStorage)) return;
      setUpdate(found);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const later = useCallback(() => {
    if (update) dismissUpdate(update.version, Date.now(), window.localStorage);
    setUpdate(null);
  }, [update]);

  const install = useCallback(async () => {
    setInstalling(true);
    try {
      await installUpdate();
    } catch (err) {
      toast.error("Update failed", {
        description: err instanceof Error ? err.message : String(err),
      });
      setInstalling(false);
    }
  }, []);

  if (!update) return null;

  return (
    <div
      role="status"
      data-testid="update-banner"
      className="flex items-center gap-3 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-[11px] text-foreground"
    >
      <Download className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate">
        Zoc AI v{update.version} is available.
      </span>
      <button
        type="button"
        onClick={() => void openReleaseNotes()}
        className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/15"
      >
        Release notes
      </button>
      <button
        type="button"
        onClick={() => void install()}
        disabled={installing}
        className="inline-flex items-center gap-1 rounded border border-primary/40 px-1.5 py-0.5 font-medium text-primary hover:bg-primary/15 disabled:opacity-60"
      >
        {installing && <Loader2 className="h-3 w-3 animate-spin" />}
        {installing ? "Updating…" : "Update now"}
      </button>
      <button
        type="button"
        onClick={later}
        aria-label="Dismiss for 24 hours"
        title="Dismiss for 24 hours"
        className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
