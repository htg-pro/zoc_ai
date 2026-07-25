import { useCallback, useEffect, useState } from "react";
import { Copy, Eye, Loader2, Radio, Square } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import {
  onShareViewers,
  shareSession,
  shareSessionStatus,
  shareSessionStop,
  type ShareInfo,
} from "@/lib/tauri-bridge";
import { currentViewerContext, qrDataUrl, viewersLabel } from "./share-session";
import { isTerminal } from "./agent-runs";
import { useApp } from "@/lib/store";

/**
 * Host-side share dialog (§10.1): starts the read-only LAN listener, shows the
 * URL plus a QR code for phones, and tracks how many people are watching.
 */
export function ShareSessionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [viewers, setViewers] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runId = useApp((state) => state.runId);
  const focusedRunId = useApp((state) => state.focusedRunId ?? null);
  const trackedRuns = useApp((state) => state.trackedRuns ?? []);
  const focused = trackedRuns.find((run) => run.runId === focusedRunId && !isTerminal(run));
  const shareRunId = focused?.runId
    ?? trackedRuns.find((run) => !isTerminal(run))?.runId
    ?? runId;

  // Reflect an already-running share when the dialog reopens.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void shareSessionStatus().then((current) => {
      if (cancelled || !current) return;
      setInfo(current);
      setViewers(current.viewers);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!info) {
      setQr(null);
      return;
    }
    let cancelled = false;
    void qrDataUrl(info.url).then((data) => {
      if (!cancelled) setQr(data);
    });
    return () => {
      cancelled = true;
    };
  }, [info]);

  useEffect(() => {
    let off: (() => void) | undefined;
    void onShareViewers(setViewers).then((fn) => {
      off = fn;
    });
    return () => off?.();
  }, []);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (!shareRunId) {
        throw new Error("Start a run before sharing its live session.");
      }
      const started = await shareSession(shareRunId);
      setInfo(started);
      setViewers(started.viewers);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [shareRunId]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await shareSessionStop();
      setInfo(null);
      setViewers(0);
    } finally {
      setBusy(false);
    }
  }, []);

  const copy = useCallback(async () => {
    if (!info) return;
    try {
      await navigator.clipboard.writeText(info.url);
      toast.success("Share link copied");
    } catch {
      toast.error("Couldn't copy the link");
    }
  }, [info]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="h-4 w-4 text-[#9B6AF1]" />
            Share session (read-only)
          </DialogTitle>
          <DialogDescription>
            People on your local network can watch this run live. They cannot
            send messages, approve decisions, or change any file — the shared
            endpoint only serves the event stream.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            {error}
          </div>
        )}

        {info ? (
          <div className="space-y-3">
            {qr && (
              <img
                src={qr}
                alt="QR code for the share link"
                className="mx-auto rounded-md border border-border"
                width={220}
                height={220}
              />
            )}
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border border-border bg-muted px-2 py-1.5 font-mono text-[11px]">
                {info.url}
              </code>
              <Button size="icon" variant="ghost" onClick={() => void copy()} title="Copy link">
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
              <span data-testid="share-viewer-count">{viewersLabel(viewers)}</span>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Anyone with this link can watch until you stop sharing. Treat it
              like a password.
            </p>
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground">
            {shareRunId
              ? "Sharing starts a temporary listener on your local network. It stops when you close the app or press Stop."
              : "Start an agent run first, then share its live read-only feed."}
          </p>
        )}

        <DialogFooter>
          {info ? (
            <Button variant="destructive" size="sm" disabled={busy} onClick={() => void stop()}>
              {busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Square className="mr-1 h-3 w-3 fill-current" />
              )}
              Stop sharing
            </Button>
          ) : (
            <Button size="sm" disabled={busy || !shareRunId} onClick={() => void start()}>
              {busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Radio className="mr-1 h-3.5 w-3.5" />
              )}
              Start sharing
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Thin banner shown to a *viewer* of somebody else's session, so it is always
 * obvious that this window cannot act.
 */
export function ViewerBanner() {
  const [context] = useState(currentViewerContext);

  if (!context.readOnly) return null;

  return (
    <div
      role="status"
      data-testid="viewer-banner"
      className="flex items-center justify-center gap-2 border-b border-[#9B6AF1]/30 bg-[#9B6AF1]/10 px-3 py-1 text-[11px] text-[#C4B5FD]"
    >
      <Eye className="h-3 w-3" />
      <span>
        Viewing {context.host ?? "the host"}&apos;s session (read-only)
      </span>
    </div>
  );
}
