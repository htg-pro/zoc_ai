import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldOff, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "@/components/ui/toast";
import {
  desktopConfigGet,
  desktopConfigSet,
  telemetryClear,
  telemetryStats,
  type DesktopConfig,
  type TelemetryStats,
} from "@/lib/tauri-bridge";
import { TELEMETRY_ENDPOINT, invalidateConsent } from "@/lib/telemetry";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Settings → Privacy (§11.2).
 *
 * The single switch is the authoritative consent flag: turning it off stops
 * collection at the Rust write path, so no further events are recorded and
 * nothing can be uploaded.
 */
export function PrivacySection() {
  const [config, setConfig] = useState<DesktopConfig | null>(null);
  const [stats, setStats] = useState<TelemetryStats | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const [cfg, current] = await Promise.all([desktopConfigGet(), telemetryStats()]);
    setConfig(cfg);
    setStats(current);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const toggle = async (enabled: boolean) => {
    if (!config) return;
    setBusy(true);
    try {
      const next = await desktopConfigSet({ ...config, telemetry_opt_in: enabled });
      setConfig(next);
      // The cached consent flag would otherwise keep the old answer.
      invalidateConsent();
      await refresh();
      toast.message(enabled ? "Anonymous usage stats enabled" : "Telemetry disabled");
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    await telemetryClear();
    await refresh();
    toast.success("Local telemetry data deleted");
  };

  const optedIn = !!config?.telemetry_opt_in;

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ShieldOff className="h-4 w-4" /> Privacy
        </h2>
        <p className="text-xs text-muted-foreground">
          Zoc is local-first. Nothing leaves your machine unless you turn the
          switch below on.
        </p>
      </header>

      <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
        <div className="space-y-1">
          <Label htmlFor="telemetry-toggle" className="text-xs font-medium">
            Share anonymous usage stats
          </Label>
          <p className="text-[11px] text-muted-foreground">
            No code, no file names, no personal data — only counters like run
            duration, which mode you used, and whether a run succeeded.
          </p>
          <p className="text-[10.5px] text-muted-foreground">
            When enabled, batches are sent to{" "}
            <code className="font-mono">{TELEMETRY_ENDPOINT}</code>.
          </p>
        </div>
        <Switch
          id="telemetry-toggle"
          checked={optedIn}
          disabled={busy || !config}
          onCheckedChange={(v) => void toggle(v)}
        />
      </div>

      {stats && (
        <div className="rounded-lg border border-border p-3 text-xs">
          <div className="mb-2 font-medium">Local telemetry store</div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-muted-foreground">
            <dt>Pending events</dt>
            <dd className="font-mono">{stats.events}</dd>
            <dt>Size</dt>
            <dd className="font-mono">{formatBytes(stats.bytes)}</dd>
            <dt>Location</dt>
            <dd className="truncate font-mono" title={stats.path}>
              {stats.path || "—"}
            </dd>
          </dl>
          <Button
            size="sm"
            variant="ghost"
            className="mt-2 text-destructive"
            disabled={stats.events === 0}
            onClick={() => void clear()}
          >
            {busy ? (
              <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="mr-1 h-3.5 w-3.5" />
            )}
            Delete local telemetry data
          </Button>
        </div>
      )}
    </section>
  );
}
