import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";
import { useApp } from "@/lib/store";

/**
 * Cmd-K inline-edit prompt. A floating input that appears over the editor when
 * a selection is captured; the user types an instruction and the rewritten
 * selection is queued as a reviewable patch.
 */
export function InlineEditPrompt({ filePath }: { filePath: string }) {
  const ie = useApp((s) => s.inlineEdit);
  const submit = useApp((s) => s.submitInlineEdit);
  const close = useApp((s) => s.closeInlineEdit);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = ie.open && ie.filePath === filePath;

  useEffect(() => {
    if (visible) {
      setValue("");
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [visible]);

  if (!visible) return null;

  const busy = ie.status === "loading";
  const run = () => {
    if (!busy && value.trim()) void submit(value);
  };

  return (
    <div className="absolute left-1/2 top-3 z-20 w-[min(680px,92%)] -translate-x-1/2">
      <div className="rounded-lg border border-[var(--zoc-border,#2a2a32)] bg-[var(--zoc-panel,#16161c)] shadow-xl">
        <div className="flex items-center gap-2 px-3 py-2">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--zoc-ember,#fb923c)]" />
          <input
            ref={inputRef}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                run();
              } else if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
            placeholder="Edit the selection… (e.g. add error handling, convert to async)"
            className="flex-1 bg-transparent text-[12.5px] text-[var(--zoc-text,#fafafa)] outline-none placeholder:text-[var(--zoc-text-muted,#71717a)]"
          />
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[var(--zoc-text-muted,#71717a)]" />
          ) : (
            <button
              type="button"
              aria-label="Cancel inline edit"
              onClick={close}
              className="text-[var(--zoc-text-muted,#71717a)] hover:text-[var(--zoc-text,#fafafa)]"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="flex items-center justify-between px-3 pb-1.5 text-[10.5px] text-[var(--zoc-text-muted,#71717a)]">
          <span>{busy ? "Generating edit…" : "Enter to apply · Esc to cancel"}</span>
          {ie.error ? <span className="text-[var(--zoc-error,#f87171)]">{ie.error}</span> : null}
        </div>
      </div>
    </div>
  );
}
