import { useEffect, useState } from "react";
import type { PermissionScope, ToolCall, ToolCallStatus } from "@llama-studio/shared-types";
import { Check, ChevronDown, Loader2, RotateCw, ShieldCheck, Square, Wrench, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ORPHANED_APPROVAL_MESSAGE } from "@/lib/constants";
import { useApp } from "@/lib/store";
import { track } from "@/lib/telemetry";
import { cn } from "@/lib/utils";

const STATUS_BADGE: Record<ToolCallStatus, { variant: "success" | "warning" | "muted" | "destructive" | "default"; label: string; Icon: typeof Check }> = {
  pending: { variant: "muted", label: "pending", Icon: Loader2 },
  running: { variant: "default", label: "running", Icon: Loader2 },
  succeeded: { variant: "success", label: "ok", Icon: Check },
  failed: { variant: "destructive", label: "failed", Icon: XCircle },
  cancelled: { variant: "muted", label: "cancelled", Icon: XCircle },
  needs_approval: { variant: "warning", label: "needs approval", Icon: ShieldCheck },
};

const UNKNOWN_STATUS = {
  variant: "warning" as const,
  label: "unknown",
  Icon: ShieldCheck,
};

type BusyKind = "once" | "tool" | "scope" | "deny" | "retry";

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(
    call.status === "needs_approval" ||
      (call.status === "cancelled" && call.error === ORPHANED_APPROVAL_MESSAGE),
  );
  const [busy, setBusy] = useState<BusyKind | null>(null);
  const grantPermission = useApp((s) => s.grantPermission);
  const grantTool = useApp((s) => s.grantTool);
  const resolveApproval = useApp((s) => s.resolveApproval);
  const retryApproval = useApp((s) => s.retryApproval);
  const cancelStream = useApp((s) => s.cancelStream);
  const toolDescriptors = useApp((s) => s.toolDescriptors);
  const loadToolDescriptors = useApp((s) => s.loadToolDescriptors);

  useEffect(() => {
    if (toolDescriptors.length === 0) void loadToolDescriptors();
  }, [toolDescriptors.length, loadToolDescriptors]);

  const s = STATUS_BADGE[call.status] ?? UNKNOWN_STATUS;
  const Icon = s.Icon;
  const needsApproval = call.status === "needs_approval";
  // A call cancelled because the agent restarted mid-approval can be re-run
  // with one click instead of the user retyping the whole prompt.
  const retryable =
    call.status === "cancelled" && call.error === ORPHANED_APPROVAL_MESSAGE;
  const descriptor = toolDescriptors.find((d) => d.name === call.name);
  const scopes: PermissionScope[] = needsApproval ? descriptor?.requires_scopes ?? [] : [];

  // "Allow once" / "Allow this tool" both grant just this tool; "allow once"
  // is consumed by the backend after a single use.
  const allowTool = async (kind: "once" | "tool") => {
    setBusy(kind);
    try {
      await grantTool(call.name, kind === "once");
      await track("permission.allowed", { tool: call.name, mode: kind });
      // Resume the suspended call now that the grant is in place.
      await resolveApproval(call.id, true);
    } finally {
      setBusy(null);
    }
  };

  // Approve the whole scope(s) — the coarser, pre-existing behaviour.
  const allowScope = async () => {
    if (scopes.length === 0) return;
    setBusy("scope");
    try {
      for (const scope of scopes) {
        await grantPermission(scope, true);
        await track("permission.allowed", { tool: call.name, scope, mode: "scope" });
      }
      await resolveApproval(call.id, true);
    } finally {
      setBusy(null);
    }
  };

  const deny = async () => {
    setBusy("deny");
    try {
      for (const scope of scopes) {
        await grantPermission(scope, false);
        await track("permission.denied", { tool: call.name, scope });
      }
      // Resume the suspended call with a denial so the agent stops waiting.
      await resolveApproval(call.id, false);
    } finally {
      setBusy(null);
    }
  };

  // Re-run a restart-cancelled call: re-issues the original prompt so the
  // agent retries the step, picking up any grant the user has since made.
  const retry = async () => {
    setBusy("retry");
    try {
      await track("permission.retried", { tool: call.name });
      await retryApproval(call.id);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className={cn(
        "rounded-md border border-border bg-card/60",
        needsApproval && "border-amber-500/40 bg-amber-500/5",
        retryable && "border-sky-500/40 bg-sky-500/5",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Wrench className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="flex-1 truncate font-mono text-xs">{call.name}</span>
        <Badge variant={s.variant}>
          <Icon className={cn("h-3 w-3", (call.status === "running" || busy) && "animate-spin")} />
          {s.label}
        </Badge>
        <ChevronDown className={cn("h-3 w-3 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-2 border-t border-border px-2.5 py-2 text-[11px]">
          {needsApproval && (
            <div className="flex flex-col gap-2 rounded border border-amber-500/40 bg-amber-500/10 p-2">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                <div className="flex-1">
                  <div className="font-medium text-amber-200">
                    Agent wants to run <code className="font-mono">{call.name}</code>
                    {scopes.length > 0 && (
                      <>
                        {" "}
                        (needs{" "}
                        {scopes.map((sc, i) => (
                          <span key={sc}>
                            <code className="font-mono">{sc}</code>
                            {i < scopes.length - 1 ? " + " : ""}
                          </span>
                        ))}
                        )
                      </>
                    )}
                  </div>
                  <div className="mt-0.5 text-amber-100/70">
                    Approve just this tool, or the whole scope. Per-tool grants can be
                    revoked later in Settings → Permissions.
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  disabled={busy !== null}
                  onClick={() => void deny()}
                >
                  Deny
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  disabled={busy !== null}
                  onClick={() => void allowTool("once")}
                >
                  Allow once
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[11px]"
                  disabled={busy !== null}
                  onClick={() => void allowTool("tool")}
                >
                  Allow this tool
                </Button>
                {scopes.length > 0 && (
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void allowScope()}
                  >
                    Allow scope
                  </Button>
                )}
              </div>
            </div>
          )}
          <div>
            <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">Arguments</div>
            <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px]">
              {formatJson(call.arguments)}
            </pre>
          </div>
          {call.result !== null && call.result !== undefined && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">Result</div>
              <pre className="overflow-auto rounded bg-muted/40 p-2 font-mono text-[11px]">
                {formatJson(call.result)}
              </pre>
            </div>
          )}
          {retryable ? (
            <div className="flex flex-col gap-2 rounded border border-sky-500/40 bg-sky-500/10 p-2">
              <div className="flex items-start gap-2">
                <RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-sky-400" />
                <div className="flex-1 text-sky-100/80">
                  This step was cancelled because the agent restarted while it was
                  waiting for your decision. Retry to re-run the request — any
                  permission you've since granted will be used automatically.
                </div>
              </div>
              <div className="flex items-center justify-end">
                {busy === "retry" ? (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-6 px-2 text-[11px]"
                    aria-label="Stop retry"
                    onClick={() => cancelStream()}
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    disabled={busy !== null}
                    onClick={() => void retry()}
                  >
                    <RotateCw className="h-3 w-3" />
                    Retry
                  </Button>
                )}
              </div>
            </div>
          ) : (
            call.error && (
              <div className="rounded border border-destructive/40 bg-destructive/10 p-2 text-destructive">
                {call.error}
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(value: unknown): string {
  try {
    const out = JSON.stringify(
      value,
      (_key, item) => (typeof item === "bigint" ? item.toString() : item),
      2,
    );
    return out ?? String(value ?? "");
  } catch (err) {
    return `Unable to render payload: ${(err as Error).message}`;
  }
}
