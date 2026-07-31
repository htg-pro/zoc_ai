/**
 * The session switcher — zoc-agent-chat-rebuild R15.1, R15.3, R35.2, task 22.2.
 *
 * The header's title, as a dropdown trigger, wrapping **the** `SessionList` from `features/sessions` rather
 * than a list of its own. That is R35.2's whole point, and it is the reason this component is thin: it owns
 * the trigger, the panel width, and the new-session action, and every row decision belongs to the list.
 *
 * ## Why the chat panel is gaining a switcher rather than consolidating one
 *
 * R35's ground-truth note names "the chat panel's own switcher" as one of three implementations to merge.
 * There is no such component in `features/agent/` — `AgentMenu.tsx` is a memory menu, and the closest thing
 * to switching is `selectSession(activeSessionId)` used as a reload. So this is new work, and the
 * consolidation R35.2 asks for happens at 25.2 when the two workspace surfaces adopt the same list.
 *
 * ## Focus is not trapped, and the dropdown is where the search box lives
 *
 * Radix `DropdownMenu` traps focus and returns it on dismiss (R21.6), which is right for a menu — but the
 * list contains a text input, and a `DropdownMenuItem` would swallow typing. So the list is rendered as
 * ordinary content inside the menu, with `onSelect` handled by the rows themselves rather than by menu
 * items. The trade is deliberate: keyboard dismissal and focus return still come from Radix, and the arrow
 * keys move within the list's own rows rather than through menu items that do not exist.
 */
import { ChevronDown, Plus } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { SessionList, type SessionListProps } from "@/features/sessions/SessionList";

export interface SessionSwitcherProps extends Omit<SessionListProps, "className"> {
  /** The active Session's title, shown on the trigger. */
  title: string;
  onNewSession?: () => void;
  className?: string;
}

export function SessionSwitcher({
  title,
  onNewSession,
  className,
  ...list
}: SessionSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-zoc-session-switcher=""
          aria-label={`Session: ${title}. Choose another session`}
          className={cn(
            "flex min-w-0 items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5",
            "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-[color:var(--zoc-agent-strong)]",
            className,
          )}
          style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
        >
          {/* Truncated last under the header's container query: the title is the most useful thing on it. */}
          <span className="zoc-header-session-title truncate">{title}</span>
          <ChevronDown aria-hidden className="size-3 shrink-0" style={{ color: "var(--zoc-text-faint)" }} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-96 p-0"
        data-zoc-session-switcher-panel=""
        style={{ backgroundColor: "var(--zoc-elev-2)", borderColor: "var(--zoc-border)" }}
      >
        {onNewSession === undefined ? null : (
          <button
            type="button"
            data-zoc-new-session=""
            onClick={onNewSession}
            className="flex w-full items-center gap-2 px-2 py-1.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
          >
            <Plus aria-hidden className="size-3.5 shrink-0" />
            New session
          </button>
        )}
        <SessionList {...list} className="max-h-80" />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
