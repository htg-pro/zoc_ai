import { useEffect, useRef, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { Check, Loader2, Sparkles, X } from "lucide-react";
import { toast } from "@/components/ui/toast";
import {
  streamInlineEdit,
  type InlineEditRequest,
} from "@/features/chat/wire/inline-edit-client";
import {
  AgentEditAnimator,
  singleReplacePlan,
  type AgentEditMeta,
  type AnimatorEditorHandle,
  type PlannedEdit,
} from "./AgentEditAnimator";

/**
 * The captured selection an inline edit operates on. Built by `MonacoView` from
 * the editor selection when ⌘K fires and passed down as a prop — the overlay
 * keeps all of its own state local (no store coupling).
 */
export interface InlineEditOverlayContext {
  filePath: string;
  language: string;
  /** The selected code being edited (the diff "original" side). */
  selection: string;
  /** ≤window chars before/after the selection, for model context. */
  prefix: string;
  suffix: string;
  /** Selection offsets into the full model text at capture time. */
  start: number;
  end: number;
  /** Full model text at capture time (used to build the apply plan). */
  fullText: string;
  /** Pixel offset inside the editor, positioned just above the edit range. */
  anchorTop: number;
}

export interface InlineEditOverlayProps {
  /** Non-null while the overlay is open for a captured selection. */
  context: InlineEditOverlayContext | null;
  /** Late-bound accessor for the live editor (applied on Accept). */
  getEditor: () => AnimatorEditorHandle | null;
  /** Mounted MonacoView animator; optional for isolated component rendering. */
  applyPlan?: (plan: PlannedEdit[], meta?: AgentEditMeta) => Promise<PlannedEdit[]>;
  /** Cancel a currently applying edit sequence. */
  cancelApply?: () => void;
  /** Close the overlay (clears the captured selection in the parent). */
  onClose: () => void;
}

type Phase = "input" | "streaming" | "ready" | "applying" | "error";

/**
 * ⌘K inline-edit overlay (Part 8.2).
 *
 * A floating instruction input anchored over the editor. On submit it streams
 * the rewrite from `POST /v1/agent/inline-edit` into a live Monaco diff preview
 * (original selection ↔ streamed replacement). Accept applies the replacement
 * through the {@link AgentEditAnimator} (green-flash, single undo, per-file
 * toast); Discard/Esc aborts the stream and closes.
 */
export function InlineEditOverlay({
  context,
  getEditor,
  applyPlan,
  cancelApply,
  onClose,
}: InlineEditOverlayProps) {
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>("input");
  const [streamed, setStreamed] = useState("");
  const [final, setFinal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Reset + focus whenever a new selection opens the overlay.
  useEffect(() => {
    if (!context) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setInstruction("");
    setStreamed("");
    setFinal("");
    setError(null);
    setPhase("input");
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [context]);

  // Abort any in-flight stream on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  if (!context) return null;

  const submit = (): void => {
    const text = instruction.trim();
    if (!text || phase === "streaming") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("streaming");
    setStreamed("");
    setFinal("");
    setError(null);

    const req: InlineEditRequest = {
      instruction: text,
      code: context.selection,
      prefix: context.prefix,
      suffix: context.suffix,
      language: context.language,
      filePath: context.filePath,
    };

    streamInlineEdit(req, {
      signal: controller.signal,
      onToken: (chunk) => {
        if (controller.signal.aborted) return;
        setStreamed((s) => s + chunk);
      },
    })
      .then((replacement) => {
        if (controller.signal.aborted) return;
        setStreamed(replacement);
        setFinal(replacement);
        setPhase("ready");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Inline edit failed");
        setPhase("error");
      });
  };

  const accept = async (): Promise<void> => {
    const editor = getEditor();
    if (!editor || phase !== "ready") return;
    setPhase("applying");
    setError(null);
    const plan = [singleReplacePlan(context.fullText, context.start, context.end, final)];
    try {
      const meta = { filePath: context.filePath, baseText: context.fullText };
      const applied = applyPlan
        ? await applyPlan(plan, meta)
        : await new AgentEditAnimator({
            editor,
            toast: {
              success: (message, options) => void toast.success(message, options),
              error: (message, options) => void toast.error(message, options),
            },
          }).applyPlan(plan, meta);
      if (applied.length !== plan.length) {
        setError("The buffer changed. Reopen the inline edit and try again.");
        setPhase("error");
        return;
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't apply inline edit");
      setPhase("error");
    }
  };

  const discard = (): void => {
    abortRef.current?.abort();
    if (phase === "applying") cancelApply?.();
    onClose();
  };

  const busy = phase === "streaming" || phase === "applying";
  const showPreview = phase === "streaming" || phase === "ready" || phase === "applying";

  return (
    <div
      className="absolute left-3 right-3 z-20 max-w-[720px] font-mono"
      style={{ top: context.anchorTop }}
      role="dialog"
      aria-label="Inline edit"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          discard();
        } else if (e.key === "Tab" && phase === "ready") {
          e.preventDefault();
          void accept();
        }
      }}
    >
      <div className="overflow-hidden rounded-lg border border-[var(--zoc-ember,#fb923c)] bg-[var(--zoc-panel,#16161c)] shadow-xl">
        <div className="flex items-center gap-2 px-3 py-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--zoc-ember,#fb923c)]" />
          <input
            ref={inputRef}
            value={instruction}
            disabled={busy}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (phase === "ready") void accept();
                else submit();
              }
            }}
            placeholder="Edit selected code with AI..."
            className="flex-1 bg-transparent text-[12.5px] text-[var(--zoc-text,#fafafa)] outline-none placeholder:text-[var(--zoc-text-muted,#71717a)]"
          />
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--zoc-text-muted,#71717a)]" />
          ) : null}
          <button
            type="button"
            aria-label="Cancel inline edit"
            onClick={discard}
            className="text-[var(--zoc-text-muted,#71717a)] hover:text-[var(--zoc-text,#fafafa)]"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {showPreview ? (
          <div className="border-t border-[var(--zoc-border,#2a2a32)]">
            <DiffEditor
              height={220}
              theme="vs-dark"
              language={context.language || undefined}
              original={context.selection}
              modified={streamed}
              options={{
                readOnly: true,
                renderSideBySide: false,
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: "off",
                glyphMargin: false,
                folding: false,
                fontSize: 12.5,
              }}
            />
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-3 px-3 py-2 text-[10.5px] text-[var(--zoc-text-muted,#71717a)]">
          <span>
            {phase === "streaming"
              ? "Generating edit…"
              : phase === "applying"
                ? "Applying edit…"
                : phase === "ready"
                ? "Enter / Accept to apply · Esc to discard"
                : phase === "error"
                  ? "Something went wrong"
                  : "Enter to generate · Esc to cancel"}
          </span>
          <span className="flex items-center gap-2">
            {error ? <span className="text-[var(--zoc-error,#f87171)]">{error}</span> : null}
            {phase === "ready" ? (
              <>
                <button
                  type="button"
                  onClick={discard}
                  className="rounded px-2 py-1 text-[var(--zoc-text-muted,#71717a)] hover:text-[var(--zoc-text,#fafafa)]"
                >
                  Discard (Esc)
                </button>
                <button
                  type="button"
                  onClick={accept}
                  className="flex items-center gap-1 rounded bg-[var(--zoc-accent,#6366f1)] px-2 py-1 font-medium text-white hover:opacity-90"
                >
                  <Check className="h-3 w-3" />
                  Accept (Tab)
                </button>
              </>
            ) : null}
          </span>
        </div>
      </div>
    </div>
  );
}
