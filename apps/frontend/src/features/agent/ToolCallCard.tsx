import { useEffect, useState } from "react";
import type { PermissionScope, ToolCall, ToolCallStatus } from "@zoc-studio/shared-types";
import {
  Check,
  ChevronDown,
  Loader2,
  RotateCw,
  ShieldCheck,
  Square,
  Wrench,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ORPHANED_APPROVAL_MESSAGE } from "@/lib/constants";
import { useApp } from "@/lib/store";
import { track } from "@/lib/telemetry";
import { cn } from "@/lib/utils";

const STATUS_META: Record<
  ToolCallStatus,
  { color: string; label: string; spin?: boolean }
> = {
  pending:        { color: "text-[#71717A]",              label: "pending" },
  running:        { color: "text-[#9B6AF1]",              label: "running", spin: true },
  succeeded:      { color: "text-[var(--zoc-success)]",   label: "ok" },
  failed:         { color: "text-[var(--zoc-error)]",     label: "failed" },
  cancelled:      { color: "text-[#71717A]",              label: "cancelled" },
  needs_approval: { color: "text-[var(--zoc-ember)]",     label: "needs approval" },
};

const UNKNOWN_STATUS = { color: "text-[#71717A]", label: "unknown" };

type BusyKind = "once" | "tool" | "scope" | "deny" | "retry";

export function ToolCallCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(
    call.status === "needs_approval" ||
      (call.status === "cancelled" && call.error === ORPHANED_APPROVAL_MESSAGE),
  );
  const [busy, setBusy] = useState<BusyKind | null>(null);

  const grantPermission    = useApp((s) => s.grantPermission);
  const grantTool          = useApp((s) => s.grantTool);
  const resolveApproval    = useApp((s) => s.resolveApproval);
  const retryApproval      = useApp((s) => s.retryApproval);
  const cancelStream       = useApp((s) => s.cancelStream);
  const toolDescriptors    = useApp((s) => s.toolDescriptors);
  const loadToolDescriptors = useApp((s) => s.loadToolDescriptors);

  useEffect(() => {
    if (toolDescriptors.length === 0) void loadToolDescriptors();
  }, [toolDescriptors.length, loadToolDescriptors]);

  const meta = STATUS_META[call.status] ?? UNKNOWN_STATUS;
  const needsApproval = call.status === "needs_approval";
  const retryable =
    call.status === "cancelled" && call.error === ORPHANED_APPROVAL_MESSAGE;
  const descriptor = toolDescriptors.find((d) => d.name === call.name);
  const scopes: PermissionScope[] = needsApproval ? descriptor?.requires_scopes ?? [] : [];

  const allowTool = async (kind: "once" | "tool") => {
    setBusy(kind);
    try {
      await grantTool(call.name, kind === "once");
      await track("permission.allowed", { tool: call.name, mode: kind });
      await resolveApproval(call.id, true);
    } finally { setBusy(null); }
  };

  const allowScope = async () => {
    if (scopes.length === 0) return;
    setBusy("scope");
    try {
      for (const scope of scopes) {
        await grantPermission(scope, true);
        await track("permission.allowed", { tool: call.name, scope, mode: "scope" });
      }
      await resolveApproval(call.id, true);
    } finally { setBusy(null); }
  };

  const deny = async () => {
    setBusy("deny");
    try {
      for (const scope of scopes) {
        await grantPermission(scope, false);
        await track("permission.denied", { tool: call.name, scope });
      }
      await resolveApproval(call.id, false);
    } finally { setBusy(null); }
  };

  const retry = async () => {
    setBusy("retry");
    try {
      await track("permission.retried", { tool: call.name });
      await retryApproval(call.id);
    } finally { setBusy(null); }
  };

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-[#0F0F14] animate-fade-row",
        needsApproval
          ? "border-[var(--zoc-ember)]/35"
          : retryable
            ? "border-[#60a5fa]/30"
            : "border-[#1E1E23]",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-[#141419] transition-colors"
      >
        <Wrench className="h-3.5 w-3.5 shrink-0 text-[#52525B]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#C8C8CE]">
          {call.name}
        </span>

        <span
          className={cn(
            "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-medium shrink-0",
            call.status === "succeeded"
              ? "border-[var(--zoc-success)]/30 bg-[var(--zoc-success)]/8 text-[var(--zoc-success)]"
              : call.status === "failed"
                ? "border-[var(--zoc-error)]/30 bg-[var(--zoc-error)]/8 text-[var(--zoc-error)]"
                : call.status === "needs_approval"
                  ? "border-[var(--zoc-ember)]/30 bg-[var(--zoc-ember)]/8 text-[var(--zoc-ember)]"
                  : call.status === "running"
                    ? "border-[#9B6AF1]/30 bg-[#9B6AF1]/8 text-[#9B6AF1]"
                    : "border-[#26262B] bg-[#15151A] text-[#71717A]",
          )}
        >
          {(call.status === "running" || busy) ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : call.status === "succeeded" ? (
            <Check className="h-3 w-3" />
          ) : call.status === "failed" ? (
            <XCircle className="h-3 w-3" />
          ) : null}
          {meta.label}
        </span>

        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-[#3F3F46] transition-transform duration-150",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div className="border-t border-[#1E1E23] px-3 py-2.5 space-y-2.5">
          {needsApproval && (
            <div className="flex flex-col gap-2.5 rounded-lg border border-[var(--zoc-ember)]/35 bg-[rgba(251,146,60,0.06)] p-2.5">
              <div className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--zoc-ember)]" />
                <div>
                  <div className="text-[12px] font-medium text-[#FAFAFA]">
                    Permission needed:{" "}
                    <code className="rounded bg-[#1A1A1F] px-1 py-0.5 font-mono text-[11px] text-[var(--zoc-ember)]">
                      {call.name}
                    </code>
                  </div>
                  {scopes.length > 0 && (
                    <div className="mt-0.5 text-[11px] text-[#71717A]">
                      Requires:{" "}
                      {scopes.map((sc, i) => (
                        <span key={sc}>
                          <code className="font-mono text-[#A1A1AA]">{sc}</code>
                          {i < scopes.length - 1 ? " · " : ""}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-1.5">
                <Button size="sm" variant="ghost"   className="h-6 px-2 text-[11px]" disabled={busy !== null} onClick={() => void deny()}>Deny</Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy !== null} onClick={() => void allowTool("once")}>Allow once</Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={busy !== null} onClick={() => void allowTool("tool")}>Allow tool</Button>
                {scopes.length > 0 && (
                  <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy !== null} onClick={() => void allowScope()}>Allow scope</Button>
                )}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#52525B]">Arguments</div>
            <pre className="overflow-auto rounded-lg border border-[#1A1A1F] bg-black/30 p-2.5 font-mono text-[11px] leading-snug text-[#A1A1AA]">
              {formatJson(call.arguments)}
            </pre>
          </div>

          {call.result !== null && call.result !== undefined && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-[#52525B]">Result</div>
              <pre className="overflow-auto rounded-lg border border-[#1A1A1F] bg-black/30 p-2.5 font-mono text-[11px] leading-snug text-[#A1A1AA] max-h-40">
                {formatJson(call.result)}
              </pre>
            </div>
          )}

          {retryable ? (
            <div className="flex flex-col gap-2 rounded-lg border border-[#60a5fa]/30 bg-[#60a5fa]/6 p-2.5">
              <div className="flex items-start gap-2">
                <RotateCw className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#60a5fa]" />
                <p className="text-[11.5px] text-[#A1A1AA]">
                  Cancelled while waiting for your decision. Retry to re-run — any permission you've granted will apply automatically.
                </p>
              </div>
              <div className="flex items-center justify-end">
                {busy === "retry" ? (
                  <Button size="sm" variant="destructive" className="h-6 px-2 text-[11px]" onClick={() => cancelStream()}>
                    <Square className="h-3 w-3" /> Stop
                  </Button>
                ) : (
                  <Button size="sm" className="h-6 px-2 text-[11px]" disabled={busy !== null} onClick={() => void retry()}>
                    <RotateCw className="h-3 w-3" /> Retry
                  </Button>
                )}
              </div>
            </div>
          ) : (
            call.error && (
              <div className="rounded-lg border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/8 p-2 text-[11.5px] text-[var(--zoc-error)]">
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
