import { useEffect, useState } from "react";
import { Activity, Cpu, Gauge as GaugeIcon, MemoryStick, Zap } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { resolveAgentPort } from "@/lib/agent-port";
import {
  cpuAlertLabel,
  ramGauge,
  tokensPerSecondLabel,
  vramGauge,
  type Gauge,
  type HardwareSnapshot,
} from "@/lib/status-bar";
import { cn } from "@/lib/utils";

/** Reconnect delay after the hardware stream drops. */
const RETRY_MS = 5000;

/**
 * Subscribe to `GET /v1/hardware/stream` (§16.2).
 *
 * Reconnects on failure with a fixed delay: the widget is decorative, so a lost
 * stream should quietly retry rather than surface an error.
 */
function useHardwareSnapshot(): HardwareSnapshot | null {
  const [snapshot, setSnapshot] = useState<HardwareSnapshot | null>(null);

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const connect = async () => {
      if (cancelled) return;
      let base: string;
      try {
        base = `http://127.0.0.1:${await resolveAgentPort()}`;
      } catch {
        retry = setTimeout(() => void connect(), RETRY_MS);
        return;
      }
      if (cancelled) return;
      try {
        source = new EventSource(`${base}/v1/hardware/stream`);
        source.addEventListener("hardware", (event) => {
          try {
            setSnapshot(JSON.parse((event as MessageEvent<string>).data));
          } catch {
            /* ignore a malformed frame */
          }
        });
        source.onerror = () => {
          source?.close();
          source = null;
          retry = setTimeout(() => void connect(), RETRY_MS);
        };
      } catch {
        retry = setTimeout(() => void connect(), RETRY_MS);
      }
    };

    void connect();
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, []);

  return snapshot;
}

function MiniBar({ gauge, tone }: { gauge: Gauge; tone: string }) {
  return (
    <span className="flex items-center gap-1" title={`${gauge.label}: ${gauge.detail}`}>
      <span className="text-[10px] text-muted-foreground">{gauge.label}</span>
      <span className="relative h-1.5 w-8 overflow-hidden rounded-full bg-muted">
        <span
          className={cn("absolute left-0 top-0 h-full rounded-full", tone)}
          style={{ width: `${Math.round(gauge.ratio * 100)}%` }}
        />
      </span>
    </span>
  );
}

/**
 * Status-bar hardware monitor (§16.2).
 *
 * RAM and VRAM as mini bars, tokens/second while the model is generating, and
 * CPU only when it is above the alert threshold — so the widget stays quiet
 * until something is worth noticing. Clicking it opens the detail panel.
 */
export function HardwareMonitor() {
  const snapshot = useHardwareSnapshot();
  const [open, setOpen] = useState(false);

  const ram = ramGauge(snapshot);
  const vram = vramGauge(snapshot);
  const tps = tokensPerSecondLabel(snapshot);
  const cpu = cpuAlertLabel(snapshot);

  // Nothing readable yet — render nothing rather than an empty shell.
  if (!ram && !vram && !tps && !cpu) return null;

  return (
    <>
      <button
        type="button"
        data-testid="hardware-monitor"
        onClick={() => setOpen(true)}
        title="Hardware usage — click for details"
        className="flex items-center gap-2 rounded px-1.5 py-0.5 hover:bg-accent"
      >
        {ram && <MiniBar gauge={ram} tone="bg-[#60a5fa]" />}
        {vram && <MiniBar gauge={vram} tone="bg-[#9B6AF1]" />}
        {tps && (
          <span className="flex items-center gap-0.5 text-[10px] text-[var(--zoc-success)]">
            <Zap className="h-2.5 w-2.5" />
            {tps}
          </span>
        )}
        {cpu && (
          <span className="flex items-center gap-0.5 text-[10px] text-[var(--zoc-ember)]">
            <Cpu className="h-2.5 w-2.5" />
            {cpu}
          </span>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GaugeIcon className="h-4 w-4" /> Hardware
            </DialogTitle>
            <DialogDescription>
              Live readings from the agent sidecar, sampled every 2 seconds.
            </DialogDescription>
          </DialogHeader>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
            <Row icon={MemoryStick} label="RAM" value={ram?.detail ?? "unavailable"} />
            <Row icon={GaugeIcon} label="GPU VRAM" value={vram?.detail ?? "no GPU detected"} />
            <Row
              icon={Cpu}
              label="CPU"
              value={
                snapshot?.cpu_percent === null || snapshot?.cpu_percent === undefined
                  ? "unavailable"
                  : `${Math.round(snapshot.cpu_percent)}%`
              }
            />
            <Row
              icon={Activity}
              label="Inference"
              value={
                snapshot?.llm_inference_active
                  ? (tps ?? "running")
                  : "idle"
              }
            />
          </dl>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Row({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
}) {
  return (
    <>
      <dt className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </dt>
      <dd className="text-right font-mono">{value}</dd>
    </>
  );
}
