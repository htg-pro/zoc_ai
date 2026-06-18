import { Brain } from "lucide-react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MemoryStats } from "@zoc-studio/shared-types";
import {
  DEFAULT_CONTEXT_WINDOW,
  getLocalModelsSnapshot,
  subscribeLocalModels,
} from "@/lib/local-models";
import { MOCK_PROVIDERS } from "@/lib/mock-data";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Memory-usage badge for the agent header. Shows three things at once:
 *   - a brain icon coloured by usage tone (green / amber / red),
 *   - an animated tokens-used counter (`1.2k / 128k`) that tweens from
 *     the previous value to the new one over ~600ms via rAF,
 *   - a thin progress bar whose width transitions smoothly via CSS so
 *     the user sees the budget filling instead of jumping.
 *
 * Always renders so the user can see the budget. The context window
 * tracks whichever model is currently picked: cloud models from
 * `MOCK_PROVIDERS`, local llama.cpp models from each `LocalModel.n_ctx`.
 * If the live `memoryStats` snapshot is missing or stale (different
 * model than `selectedModel`), the indicator falls back to a
 * client-side estimate so it never lags behind the picker.
 */
export function MemoryIndicator() {
  const liveStats = useApp((s) => s.memoryStats);
  const liveMode = useApp((s) => s.liveMode);
  const loadMemoryStats = useApp((s) => s.loadMemoryStats);
  const chat = useApp((s) => s.chat);
  const selectedModel = useApp((s) => s.selectedModel);
  // Subscribe to the local-models store too — picking a `.gguf` should
  // immediately switch the bar to that model's `n_ctx`.
  const localModels = useSyncExternalStore(
    subscribeLocalModels,
    getLocalModelsSnapshot,
    getLocalModelsSnapshot,
  );

  // Resolved context window for the currently picked model. Cloud
  // catalogue first, then local-models n_ctx, then the safe default.
  const ctxWindow = useMemo(
    () => resolveContextWindow(selectedModel.model, localModels),
    [selectedModel.model, localModels],
  );

  // Build a client-side estimate keyed on (chat, model). This is the
  // source of truth whenever `liveStats` is missing OR is stale (i.e.
  // came from a different model whose window doesn't match).
  const fallback = useMemo<MemoryStats>(() => {
    const messageTokens = chat.reduce((acc, e) => {
      const content = e.message?.content ?? "";
      return acc + Math.max(1, Math.ceil(content.length / 4)) + 8;
    }, 0);
    const messagesInContext = chat.filter((e) => e.kind === "message").length;
    return {
      context_window: ctxWindow,
      tokens_used: messageTokens,
      tokens_available: Math.max(0, ctxWindow - messageTokens),
      messages_in_context: messagesInContext,
      total_messages: messagesInContext,
      dropped_messages: 0,
      has_summary: false,
    };
  }, [chat, ctxWindow]);

  // Reject the live snapshot if its `context_window` doesn't match the
  // picked model's window — that means it was computed for a different
  // model and would mislead the user. The store also clears it on model
  // switch (see `setSelectedModel`), this is a defence in depth.
  const liveMatches =
    liveStats !== null && liveStats.context_window === ctxWindow;
  const stats = liveMatches ? liveStats : fallback;
  const isEstimate = !liveMatches;

  const [displayedTokens, setDisplayedTokens] = useState<number>(stats.tokens_used);
  const tweenRef = useRef<number | null>(null);

  useEffect(() => {
    if (liveMode) void loadMemoryStats();
  }, [liveMode, loadMemoryStats]);

  // rAF tween from the currently-displayed value to the latest target.
  useEffect(() => {
    const target = stats.tokens_used;
    const start = displayedTokens;
    const delta = target - start;
    if (delta === 0) return;
    const startedAt = performance.now();
    const duration = 600;
    if (tweenRef.current !== null) cancelAnimationFrame(tweenRef.current);
    const tick = (now: number) => {
      const t = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayedTokens(Math.round(start + delta * eased));
      if (t < 1) {
        tweenRef.current = requestAnimationFrame(tick);
      } else {
        tweenRef.current = null;
      }
    };
    tweenRef.current = requestAnimationFrame(tick);
    return () => {
      if (tweenRef.current !== null) cancelAnimationFrame(tweenRef.current);
      tweenRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.tokens_used]);

  const pct = Math.min(
    100,
    Math.max(0, (stats.tokens_used / ctxWindow) * 100),
  );
  const tone = pct < 60 ? "ok" : pct < 85 ? "warn" : "danger";

  const tooltip = [
    isEstimate ? "Client-side estimate" : null,
    `${stats.messages_in_context} of ${stats.total_messages} messages in context`,
    `${stats.tokens_used.toLocaleString()} / ${ctxWindow.toLocaleString()} tokens (${pct.toFixed(1)}%)`,
    stats.dropped_messages > 0
      ? `${stats.dropped_messages} older message(s) outside the window`
      : null,
    stats.has_summary ? "Summary active" : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded border border-border bg-background px-1.5 py-[2px] text-[10px] tabular-nums",
        isEstimate && "border-dashed opacity-80",
      )}
      title={tooltip}
      aria-label={`Context: ${formatTokens(stats.tokens_used)} of ${formatTokens(ctxWindow)} used`}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={ctxWindow}
      aria-valuenow={stats.tokens_used}
    >
      <Brain
        className={cn("h-3 w-3 transition-colors duration-300", {
          "text-emerald-400": tone === "ok",
          "text-amber-400": tone === "warn",
          "text-destructive": tone === "danger",
        })}
      />
      <span className="font-mono">
        {formatTokens(displayedTokens)}
        <span className="opacity-60">
          {" / "}
          {formatTokens(ctxWindow)}
        </span>
      </span>
      <div
        className="relative h-1 w-10 overflow-hidden rounded-full bg-muted"
        aria-hidden="true"
      >
        <div
          className={cn(
            "absolute left-0 top-0 h-full rounded-full transition-[width,background-color] duration-500 ease-out",
            tone === "ok" && "bg-emerald-400",
            tone === "warn" && "bg-amber-400",
            tone === "danger" && "bg-destructive animate-pulse",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Resolve the context window for a model id, picker-aware:
 *  cloud catalogue → local-models n_ctx → DEFAULT_CONTEXT_WINDOW. */
function resolveContextWindow(
  modelId: string,
  localModels: ReadonlyArray<{ id: string; n_ctx?: number }>,
): number {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  for (const p of MOCK_PROVIDERS) {
    for (const m of p.models) {
      if (m.model_id === modelId) return m.capability.context_window;
    }
  }
  for (const lm of localModels) {
    if (lm.id === modelId && lm.n_ctx && lm.n_ctx > 0) return lm.n_ctx;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/** Compact human-readable token count: 1234 → "1.2k", 128000 → "128k". */
function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toString();
}
