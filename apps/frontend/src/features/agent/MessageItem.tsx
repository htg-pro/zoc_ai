import type { Message } from "@zoc-studio/shared-types";
import { Bot, User, Wrench, Settings as Cog } from "lucide-react";
import { cn } from "@/lib/utils";

const ROLE_ICON = { user: User, assistant: Bot, system: Cog, tool: Wrench } as const;
const ROLE_LABEL = { user: "You", assistant: "Agent", system: "System", tool: "Tool" } as const;

/**
 * Chat bubble. The user's own messages anchor to the right with a
 * primary-tinted background; the agent and any system / tool messages
 * anchor to the left with a neutral background, which matches the
 * conventional "me on the right, them on the left" chat layout.
 *
 * The avatar always sits on the speaker's side (right for user, left
 * for everyone else) and the column reverses when the user is speaking
 * via `flex-row-reverse`.
 */
export function MessageItem({ message }: { message: Message }) {
  const Icon = ROLE_ICON[message.role];
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const isError =
    isSystem &&
    (message.content.startsWith("Error:") ||
      message.content.includes("No workspace selected") ||
      message.content.includes("llama-server"));

  return (
    <div className={cn("flex gap-2.5", isUser && "flex-row-reverse")}>
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
          isUser ? "bg-primary/15 text-primary" : "bg-accent text-foreground",
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      <div className={cn("flex min-w-0 max-w-[85%] flex-col", isUser && "items-end")}>
        <div
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider text-muted-foreground",
            isUser && "text-right",
          )}
        >
          {ROLE_LABEL[message.role]}
        </div>
        <div
          className={cn(
            "mt-0.5 whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm leading-relaxed",
            isUser
              ? "rounded-tr-sm bg-primary/10 text-foreground"
              : isError
                ? "rounded-tl-sm border border-destructive/50 bg-destructive/10 text-destructive"
                : isSystem
                ? "rounded-tl-sm border border-border bg-muted/40 text-muted-foreground"
                : "rounded-tl-sm bg-accent/40 text-foreground",
          )}
        >
          {message.content}
        </div>
      </div>
    </div>
  );
}
