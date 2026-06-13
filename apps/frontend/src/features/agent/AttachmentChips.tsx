import { FileCode, Highlighter, X } from "lucide-react";
import { useApp } from "@/lib/store";

export function AttachmentChips() {
  const items = useApp((s) => s.attachments);
  const remove = useApp((s) => s.removeAttachment);
  if (items.length === 0) return null;
  return (
    <div className="mb-1.5 flex flex-wrap gap-1">
      {items.map((a) => {
        const Icon = a.kind === "file" ? FileCode : Highlighter;
        return (
          <span
            key={a.id}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-1.5 py-0.5 text-[11px]"
          >
            <Icon className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono">{a.label}</span>
            <button
              type="button"
              onClick={() => remove(a.id)}
              aria-label={`Remove ${a.label}`}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}
