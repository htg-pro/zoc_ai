/** Image/document attachment policy and wire conversion — zoc-agent-chat-rebuild R29. */
/** Feature: zoc-agent-chat-rebuild, task 33.1 (R29.2, R29.3, R29.4, R29.5, R29.6). */

import type { FileUIPart } from "ai";

export const DEFAULT_ATTACHMENT_LIMIT_BYTES = 10 * 1024 * 1024;
export const MAX_EXTRACTED_TEXT_CHARS = 1_000_000;

const IMAGE_MEDIA_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

const DOCUMENT_EXTENSIONS = new Set([
  "csv",
  "html",
  "htm",
  "json",
  "log",
  "md",
  "markdown",
  "rst",
  "txt",
  "tsv",
  "xml",
  "yaml",
  "yml",
]);

export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MEDIA_TYPES,
  "text/*",
  ".csv",
  ".html",
  ".json",
  ".log",
  ".md",
  ".rst",
  ".tsv",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
].join(",");

export type AttachmentKind = "image" | "document";

export interface ComposerAttachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  /** Persistable data URL used by the native UI-message `file` part. */
  readonly url: string;
  /** Extracted document text. Images deliberately carry none. */
  readonly text?: string;
  readonly estimatedTokens: number;
}

export type AttachmentRejectionCode =
  | "image_unsupported"
  | "too_large"
  | "unsupported_document"
  | "read_failed";

export interface AttachmentGate {
  readonly accepted: boolean;
  readonly reasons: readonly AttachmentRejectionCode[];
}

/** Pure policy used by the tray and Property 69. */
export function attachmentGate(input: {
  readonly kind: AttachmentKind;
  readonly size: number;
  readonly supportsImages: boolean;
  readonly sizeLimit: number;
}): AttachmentGate {
  const reasons: AttachmentRejectionCode[] = [];
  if (input.kind === "image" && !input.supportsImages) reasons.push("image_unsupported");
  if (input.size > input.sizeLimit) reasons.push("too_large");
  return { accepted: reasons.length === 0, reasons };
}

export function formatAttachmentBytes(bytes: number): string {
  const safe = Math.max(0, bytes);
  if (safe < 1024) return `${String(Math.round(safe))} B`;
  if (safe < 1024 * 1024) return `${(safe / 1024).toFixed(1).replace(/\.0$/u, "")} KiB`;
  return `${(safe / (1024 * 1024)).toFixed(1).replace(/\.0$/u, "")} MiB`;
}

export function estimateDocumentTokens(text: string): number {
  // The same deliberately conservative, tokenizer-independent estimate used by the composer census.
  return Math.max(1, Math.ceil(text.length / 4));
}

export function attachmentErrorMessage(
  code: AttachmentRejectionCode,
  input: { readonly name: string; readonly size: number; readonly sizeLimit: number },
): string {
  switch (code) {
    case "image_unsupported":
      return "The selected model accepts text only. Choose a vision-capable model to attach an image.";
    case "too_large":
      return `${input.name} is ${formatAttachmentBytes(input.size)}. The attachment limit is ${formatAttachmentBytes(input.sizeLimit)}.`;
    case "unsupported_document":
      return `${input.name} is not a text-readable document. Attach text, Markdown, JSON, CSV, XML, YAML, or a supported image.`;
    case "read_failed":
      return `${input.name} could not be read.`;
  }
}

export function attachmentKindOf(file: Pick<File, "name" | "type">): AttachmentKind | null {
  const mediaType = file.type.toLocaleLowerCase();
  if (IMAGE_MEDIA_TYPES.has(mediaType)) return "image";
  if (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml"
  ) {
    return "document";
  }
  const extension = file.name.split(".").pop()?.toLocaleLowerCase() ?? "";
  return DOCUMENT_EXTENSIONS.has(extension) ? "document" : null;
}

function generatedAttachmentId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `attachment-${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  );
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("file read failed"));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("file did not produce a data URL"));
    };
    reader.readAsDataURL(file);
  });
}

async function readText(file: File): Promise<string> {
  const text =
    typeof file.text === "function" ? await file.text() : await new Response(file).text();
  if (text.includes("\u0000")) throw new Error("binary document");
  return text.slice(0, MAX_EXTRACTED_TEXT_CHARS);
}

export type ReadAttachmentOutcome =
  | { readonly attachment: ComposerAttachment; readonly error: null }
  | { readonly attachment: null; readonly error: string; readonly code: AttachmentRejectionCode };

/** Read one browser File after applying the complete admission policy. */
export async function readAttachment(
  file: File,
  options: { readonly supportsImages: boolean; readonly sizeLimit?: number },
): Promise<ReadAttachmentOutcome> {
  const sizeLimit = options.sizeLimit ?? DEFAULT_ATTACHMENT_LIMIT_BYTES;
  const kind = attachmentKindOf(file);
  if (kind === null) {
    return {
      attachment: null,
      code: "unsupported_document",
      error: attachmentErrorMessage("unsupported_document", {
        name: file.name,
        size: file.size,
        sizeLimit,
      }),
    };
  }

  const gate = attachmentGate({
    kind,
    size: file.size,
    supportsImages: options.supportsImages,
    sizeLimit,
  });
  const first = gate.reasons[0];
  if (first !== undefined) {
    return {
      attachment: null,
      code: first,
      error: attachmentErrorMessage(first, { name: file.name, size: file.size, sizeLimit }),
    };
  }

  try {
    const url = await readDataUrl(file);
    const text = kind === "document" ? await readText(file) : undefined;
    return {
      error: null,
      attachment: {
        id: generatedAttachmentId(),
        kind,
        name: file.name || (kind === "image" ? "Pasted image" : "Pasted document"),
        mediaType: file.type || (kind === "image" ? "image/png" : "text/plain"),
        size: file.size,
        url,
        ...(text === undefined ? {} : { text }),
        estimatedTokens: text === undefined ? 0 : estimateDocumentTokens(text),
      },
    };
  } catch {
    return {
      attachment: null,
      code: "read_failed",
      error: attachmentErrorMessage("read_failed", { name: file.name, size: file.size, sizeLimit }),
    };
  }
}

/** One attachment as the native file part `useChat` persists in the user message. */
export function attachmentFilePart(attachment: ComposerAttachment): FileUIPart {
  return {
    type: "file",
    mediaType: attachment.mediaType,
    filename: attachment.name,
    url: attachment.url,
    providerMetadata: {
      zoc: {
        attachmentId: attachment.id,
        attachmentKind: attachment.kind,
        attachmentSize: attachment.size,
        estimatedTokens: attachment.estimatedTokens,
        ...(attachment.text === undefined ? {} : { extractedText: attachment.text }),
      },
    },
  } as FileUIPart;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Restore the attachment model from a persisted native file part. */
export function attachmentFromFilePart(part: unknown): ComposerAttachment | null {
  const raw = record(part);
  if (raw?.type !== "file" || typeof raw.mediaType !== "string" || typeof raw.url !== "string") {
    return null;
  }
  const metadata = record(raw.providerMetadata);
  const zoc = record(metadata?.zoc);
  const kind =
    zoc?.attachmentKind === "image" || zoc?.attachmentKind === "document"
      ? zoc.attachmentKind
      : raw.mediaType.startsWith("image/")
        ? "image"
        : "document";
  const text = typeof zoc?.extractedText === "string" ? zoc.extractedText : undefined;
  return {
    id:
      typeof zoc?.attachmentId === "string" && zoc.attachmentId.length > 0
        ? zoc.attachmentId
        : `restored-${String(raw.filename ?? raw.url)}`,
    kind,
    name:
      typeof raw.filename === "string" && raw.filename.length > 0
        ? raw.filename
        : kind === "image"
          ? "Image attachment"
          : "Document attachment",
    mediaType: raw.mediaType,
    size: typeof zoc?.attachmentSize === "number" ? Math.max(0, zoc.attachmentSize) : 0,
    url: raw.url,
    ...(text === undefined ? {} : { text }),
    estimatedTokens:
      typeof zoc?.estimatedTokens === "number"
        ? Math.max(0, zoc.estimatedTokens)
        : text === undefined
          ? 0
          : estimateDocumentTokens(text),
  };
}

export function attachmentsFromParts(parts: readonly unknown[]): readonly ComposerAttachment[] {
  return parts.flatMap((part) => {
    const attachment = attachmentFromFilePart(part);
    return attachment === null ? [] : [attachment];
  });
}
