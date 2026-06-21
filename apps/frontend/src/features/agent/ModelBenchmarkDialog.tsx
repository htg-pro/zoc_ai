import { useEffect, useMemo, useState } from "react";
import type { ModelBenchmarkRun } from "@zoc-studio/shared-types";
import { BarChart3, Gauge, Loader2, Play, Sparkles, Timer, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import {
  getModelBenchmarkHistory,
  postModelBenchmark,
} from "./gateway-client";

interface ModelBenchmarkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: { id: string; name: string } | null;
  baseUrl: string | null;
}

export function ModelBenchmarkDialog({
  open,
  onOpenChange,
  model,
  baseUrl,
}: ModelBenchmarkDialogProps) {
  const [history, setHistory] = useState<ModelBenchmarkRun[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !model) return;
    let cancelled = false;
    setLoadingHistory(true);
    setError(null);
    void getModelBenchmarkHistory(model.id)
      .then((result) => {
        if (!cancelled) setHistory(result.runs);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not load benchmark history.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingHistory(false);
      });
    return () => {
      cancelled = true;
    };
  }, [model, open]);

  const runBenchmark = async () => {
    if (!model || !baseUrl || running) return;
    setRunning(true);
    setError(null);
    try {
      const result = await postModelBenchmark({
        modelId: model.id,
        modelName: model.name,
        baseUrl,
      });
      setHistory((current) => [result, ...current.filter((run) => run.id !== result.id)]);
      const failures = result.prompts.filter((prompt) => prompt.error).length;
      if (failures > 0) {
        toast.warning(`Benchmark completed with ${failures} failed prompt${failures === 1 ? "" : "s"}.`);
      } else {
        toast.success("Model benchmark completed.");
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Benchmark failed.";
      setError(message);
      toast.error(message);
    } finally {
      setRunning(false);
    }
  };

  const latest = history[0] ?? null;

  return (
    <Dialog open={open} onOpenChange={running ? undefined : onOpenChange}>
      <DialogContent className="max-h-[86vh] w-[calc(100vw-24px)] max-w-4xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <DialogTitle className="flex items-center gap-2">
                <Gauge className="h-4 w-4 text-cyan-400" />
                Model benchmark
              </DialogTitle>
              <DialogDescription className="mt-1 truncate font-mono text-xs">
                {model?.name ?? "No local model loaded"}
              </DialogDescription>
            </div>
            <Button
              size="sm"
              onClick={() => void runBenchmark()}
              disabled={!model || !baseUrl || running}
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              {running ? "Running 5 prompts" : "Run benchmark"}
            </Button>
          </div>
        </DialogHeader>

        <div className="min-h-[430px] overflow-y-auto px-5 py-4">
          {error && (
            <div role="alert" className="mb-4 border-l-2 border-destructive bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {loadingHistory && history.length === 0 ? (
            <div className="flex h-[360px] items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Loading history
            </div>
          ) : latest ? (
            <div className="space-y-6">
              <LatestSummary run={latest} running={running} />
              <BenchmarkHistoryChart runs={history} />
              <PromptResults run={latest} />
            </div>
          ) : (
            <div className="flex h-[360px] flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <BarChart3 className="h-7 w-7 opacity-60" />
              <div>
                <p className="text-sm font-medium text-foreground">No benchmark history</p>
                <p className="mt-1 text-xs">{model ? "Ready for the first run" : "Load a local model first"}</p>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function LatestSummary({ run, running }: { run: ModelBenchmarkRun; running: boolean }) {
  const stats = [
    {
      label: "First token",
      value: formatDuration(run.averageTimeToFirstTokenMs),
      icon: Timer,
      tone: "text-cyan-400",
    },
    {
      label: "Throughput",
      value: `${run.averageTokensPerSecond.toFixed(1)} tok/s`,
      icon: Zap,
      tone: "text-emerald-400",
    },
    {
      label: "Quality",
      value: `${run.averageQualityScore.toFixed(0)} / 100`,
      icon: Sparkles,
      tone: "text-amber-400",
    },
  ];
  return (
    <section aria-labelledby="benchmark-latest-title">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 id="benchmark-latest-title" className="text-xs font-semibold uppercase text-muted-foreground">
          Latest result
        </h3>
        <span className="text-[10px] text-muted-foreground">
          {formatRunDate(run.createdAt)} · {run.durationSeconds.toFixed(1)}s
        </span>
      </div>
      <div className={cn("grid grid-cols-1 border-y border-border sm:grid-cols-3", running && "opacity-60")}>
        {stats.map(({ label, value, icon: Icon, tone }, index) => (
          <div
            key={label}
            className={cn("flex min-h-20 items-center gap-3 px-3 py-3", index > 0 && "border-t border-border sm:border-l sm:border-t-0")}
          >
            <Icon className={cn("h-4 w-4 shrink-0", tone)} />
            <div className="min-w-0">
              <div className="text-[10px] uppercase text-muted-foreground">{label}</div>
              <div className="mt-0.5 truncate font-mono text-sm font-semibold">{value}</div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BenchmarkHistoryChart({ runs }: { runs: ModelBenchmarkRun[] }) {
  const chartRuns = useMemo(() => runs.slice(0, 6).reverse(), [runs]);
  const metrics = [
    {
      label: "First token",
      values: chartRuns.map((run) => run.averageTimeToFirstTokenMs),
      format: formatDuration,
      color: "bg-cyan-400",
    },
    {
      label: "Tokens / sec",
      values: chartRuns.map((run) => run.averageTokensPerSecond),
      format: (value: number) => value.toFixed(1),
      color: "bg-emerald-400",
    },
    {
      label: "Quality",
      values: chartRuns.map((run) => run.averageQualityScore),
      format: (value: number) => value.toFixed(0),
      color: "bg-amber-400",
    },
  ];

  return (
    <section aria-labelledby="benchmark-history-title">
      <div className="mb-3 flex items-center justify-between">
        <h3 id="benchmark-history-title" className="text-xs font-semibold uppercase text-muted-foreground">
          History
        </h3>
        <span className="text-[10px] text-muted-foreground">{runs.length} run{runs.length === 1 ? "" : "s"}</span>
      </div>
      <div
        role="img"
        aria-label={`Benchmark history chart for ${chartRuns.length} runs`}
        className="space-y-3 border-y border-border py-3"
      >
        {metrics.map((metric) => {
          const maximum = Math.max(...metric.values, 1);
          return (
            <div key={metric.label} className="grid grid-cols-[76px_minmax(0,1fr)] items-end gap-3">
              <span className="pb-1 text-[10px] text-muted-foreground">{metric.label}</span>
              <div className="flex h-12 items-end gap-1.5">
                {metric.values.map((value, index) => (
                  <div key={`${chartRuns[index].id}-${metric.label}`} className="flex h-full min-w-0 flex-1 items-end">
                    <div
                      className={cn("w-full min-w-1 rounded-t-sm opacity-85", metric.color)}
                      style={{ height: `${Math.max(5, (value / maximum) * 100)}%` }}
                      title={`${formatRunDate(chartRuns[index].createdAt)}: ${metric.format(value)}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3">
          <span />
          <div className="flex gap-1.5">
            {chartRuns.map((run) => (
              <span key={run.id} className="min-w-0 flex-1 truncate text-center text-[9px] text-muted-foreground">
                {formatShortDate(run.createdAt)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function PromptResults({ run }: { run: ModelBenchmarkRun }) {
  return (
    <section aria-labelledby="benchmark-prompts-title">
      <h3 id="benchmark-prompts-title" className="mb-3 text-xs font-semibold uppercase text-muted-foreground">
        Prompt results
      </h3>
      <div className="overflow-x-auto border-y border-border">
        <div className="min-w-[620px]">
          <div className="grid grid-cols-[minmax(150px,1fr)_100px_100px_100px] border-b border-border px-3 py-2 text-[10px] uppercase text-muted-foreground">
            <span>Prompt</span>
            <span className="text-right">First token</span>
            <span className="text-right">Tok/s</span>
            <span className="text-right">Quality</span>
          </div>
          {run.prompts.map((prompt) => (
            <div
              key={prompt.promptId}
              className="grid min-h-10 grid-cols-[minmax(150px,1fr)_100px_100px_100px] items-center border-b border-border/60 px-3 py-2 text-xs last:border-b-0"
              title={prompt.error ?? undefined}
            >
              <span className={cn("truncate", prompt.error && "text-destructive")}>{prompt.label}</span>
              {prompt.error ? (
                <span className="col-span-3 truncate text-right text-[10px] text-destructive">Failed</span>
              ) : (
                <>
                  <span className="text-right font-mono">{formatDuration(prompt.timeToFirstTokenMs)}</span>
                  <span className="text-right font-mono">{prompt.tokensPerSecond.toFixed(1)}</span>
                  <span className="text-right font-mono">{prompt.qualityScore.toFixed(0)}</span>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function formatDuration(milliseconds: number): string {
  return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(2)}s` : `${milliseconds.toFixed(0)}ms`;
}

function formatRunDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function formatShortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "run" : date.toLocaleDateString([], { month: "short", day: "numeric" });
}
