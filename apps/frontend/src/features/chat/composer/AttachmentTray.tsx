/** Attachment intake and preview tray — zoc-agent-chat-rebuild R29.1–R29.5. */
/** Feature: zoc-agent-chat-rebuild, task 33.1 (R29.1, R29.2, R29.3, R29.4, R29.5). */

import { useEffect, useId, useRef, useState } from "react";
import { FileText, Paperclip, X } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  ATTACHMENT_ACCEPT,
  DEFAULT_ATTACHMENT_LIMIT_BYTES,
  formatAttachmentBytes,
  readAttachment,
  type ComposerAttachment,
} from "./attachment-model";

export interface AttachmentTrayProps {
  readonly attachments: readonly ComposerAttachment[];
  readonly supportsImages: boolean;
  readonly onAdd: (attachment: ComposerAttachment) => void;
  readonly onRemove: (id: string) => void;
  readonly sizeLimit?: number;
  readonly disabled?: boolean;
  readonly className?: string;
}

export function AttachmentTray({
  attachments,
  supportsImages,
  onAdd,
  onRemove,
  sizeLimit = DEFAULT_ATTACHMENT_LIMIT_BYTES,
  disabled = false,
  className,
}: AttachmentTrayProps) {
  const inputId = useId();
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);

  const intake = async (files: readonly File[]) => {
    if (disabled || files.length === 0) return;
    setReading(true);
    setError(null);
    for (const file of files) {
      const outcome = await readAttachment(file, { supportsImages, sizeLimit });
      if (outcome.attachment === null) {
        setError(outcome.error);
        continue;
      }
      onAdd(outcome.attachment);
    }
    setReading(false);
  };

  // Paste and drop belong to the whole composer, not the 28 px paperclip. The tray locates that
  // ancestor once and owns the listeners, keeping attachment state and attachment intake together.
  useEffect(() => {
    const root = anchorRef.current?.closest<HTMLElement>("[data-zoc-composer]");
    if (root === undefined || root === null) return undefined;

    const paste = (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void intake(files);
    };
    const dragOver = (event: DragEvent) => {
      if ((event.dataTransfer?.files.length ?? 0) === 0) return;
      event.preventDefault();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "copy";
    };
    const drop = (event: DragEvent) => {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length === 0) return;
      event.preventDefault();
      void intake(files);
    };

    root.addEventListener("paste", paste);
    root.addEventListener("dragover", dragOver);
    root.addEventListener("drop", drop);
    return () => {
      root.removeEventListener("paste", paste);
      root.removeEventListener("dragover", dragOver);
      root.removeEventListener("drop", drop);
    };
  });

  return (
    <div className={cn("contents", className)} data-zoc-attachment-tray="">
      {attachments.length === 0 ? null : (
        <div className="order-first flex basis-full flex-wrap gap-2" data-zoc-attachment-list="">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="relative flex min-w-0 max-w-56 items-center gap-2 rounded-[var(--zoc-radius-chip)] border px-2 py-1"
              style={{ borderColor: "var(--zoc-border)", background: "var(--zoc-row-bg)" }}
              data-zoc-attachment={attachment.kind}
            >
              {attachment.kind === "image" ? (
                <img
                  src={attachment.url}
                  alt=""
                  className="size-10 shrink-0 rounded object-cover"
                  data-zoc-attachment-thumbnail=""
                />
              ) : (
                <FileText aria-hidden className="size-5 shrink-0" />
              )}
              <span className="min-w-0 pr-5">
                <span className="block truncate text-xs font-medium">{attachment.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {attachment.kind === "document"
                    ? `${String(attachment.estimatedTokens)} extracted tokens`
                    : formatAttachmentBytes(attachment.size)}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${attachment.name}`}
                className="absolute right-1 top-1 inline-flex size-5 items-center justify-center rounded hover:bg-background"
                onClick={() => onRemove(attachment.id)}
                data-zoc-attachment-remove=""
              >
                <X aria-hidden className="size-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <input
        id={inputId}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        className="sr-only"
        disabled={disabled || reading}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void intake(files);
        }}
      />
      <button
        ref={anchorRef}
        type="button"
        aria-label={reading ? "Reading attachments" : "Attach image or document"}
        aria-describedby={error === null ? undefined : `${inputId}-error`}
        disabled={disabled || reading}
        onClick={() => document.getElementById(inputId)?.click()}
        className="inline-flex size-7 items-center justify-center rounded-[var(--zoc-radius-chip)] hover:bg-[var(--zoc-row-bg)] disabled:opacity-50"
        style={{ color: "var(--zoc-text-muted)" }}
        data-zoc-attachment-picker=""
      >
        <Paperclip aria-hidden className="size-3.5" />
      </button>
      {error === null ? null : (
        <span
          id={`${inputId}-error`}
          role="alert"
          className="order-last basis-full text-xs"
          style={{ color: "var(--zoc-error)" }}
          data-zoc-attachment-error=""
        >
          {error}
        </span>
      )}
    </div>
  );
}
