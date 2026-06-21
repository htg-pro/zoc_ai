import type { Message } from "@zoc-studio/shared-types";
import { Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

const ROLE_LABEL = { user: "You", assistant: "Zoc", system: "System", tool: "Tool" } as const;

/**
 * Cursor-style chat bubble.
 * – User messages: right-aligned, pill-shaped with a subtle ember-tinted bg.
 * – Assistant / system: left-aligned with a small avatar, clean prose block.
 * – Streaming indicator: animated triple-dot shown while content is empty.
 */
export function MessageItem({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const isSystem = message.role === "system";
  const isError =
    isSystem &&
    (message.content.startsWith("Error:") ||
      message.content.includes("No workspace selected") ||
      message.content.includes("llama-server"));

  const isEmpty = !message.content.trim();

  if (isUser) {
    return (
      <div className="flex justify-end animate-fade-row">
        <div className="group relative max-w-[88%]">
          <div className="rounded-2xl rounded-br-sm bg-[#1E1040] border border-[#7C3AED]/25 px-3.5 py-2.5 text-[13px] leading-relaxed text-[#EDEDF0] shadow-sm">
            {message.content}
          </div>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex gap-2.5 animate-fade-row">
        <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--zoc-error)]/15 text-[var(--zoc-error)]">
          <span className="text-[10px] font-bold">!</span>
        </div>
        <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/8 px-3 py-2 text-[13px] leading-relaxed text-[var(--zoc-error)]">
          {message.content}
        </div>
      </div>
    );
  }

  if (isSystem) {
    return (
      <div className="flex justify-center animate-fade-row">
        <span className="rounded-full border border-[#26262B] bg-[#15151A] px-3 py-1 text-[11px] text-[#71717A]">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5 animate-fade-row">
      <div className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#2A1F4E] border border-[#7C3AED]/30 text-[#9B6AF1]">
        <Bot className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-[10px] font-semibold tracking-wide text-[#52525B] uppercase">
          {ROLE_LABEL[message.role]}
        </div>
        <div className={cn(
          "text-[13px] leading-relaxed text-[#D4D4D8] whitespace-pre-wrap break-words",
          isEmpty && "flex items-center gap-1",
        )}>
          {isEmpty ? (
            <>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#8b7cf6] animate-typing-dot [animation-delay:0ms]" />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#8b7cf6] animate-typing-dot [animation-delay:160ms]" />
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#8b7cf6] animate-typing-dot [animation-delay:320ms]" />
            </>
          ) : (
            message.content
          )}
        </div>
      </div>
    </div>
  );
}
