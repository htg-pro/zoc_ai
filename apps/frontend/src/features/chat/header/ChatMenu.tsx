/**
 * The panel's overflow menu — zoc-agent-chat-rebuild R34.4, task 22.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 22.2 (R34.4).
 *
 * A Radix `DropdownMenu` holding the actions that are neither per-turn nor per-Run: compacting the
 * conversation, restarting the runtime, and whatever the header's container query has pushed in here.
 *
 * ## Why the items are props rather than a fixed list
 *
 * The menu is also the header's overflow target: below 440 px the model picker and the context figure move
 * into it (R11.1 keeps Approval, the pill, and the mark on the row). What can move depends on what the panel
 * supplied in the first place, so the menu takes the actions it should offer and renders exactly those — an
 * item whose handler is absent is absent, following the panel's rule for controls that cannot act.
 */
import { MoreVertical, RotateCcw, Scissors, ScrollText } from "lucide-react";
import type { ReactNode } from "react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ChatMenuProps {
  /** `POST /v1/sessions/:id/compact` (R34.4). */
  onCompact?: () => void;
  /** Restart the Agent_Runtime sidecar (R3.8). */
  onRestartRuntime?: () => void;
  /** Open the rules and steering editor (R30.1). */
  onOpenRules?: () => void;
  /** Whatever the container query pushed in: the model picker and the context figure, as elements. */
  overflow?: ReactNode;
  className?: string;
}

export function ChatMenu({
  onCompact,
  onRestartRuntime,
  onOpenRules,
  overflow,
  className,
}: ChatMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-zoc-chat-menu=""
          aria-label="Panel actions"
          className={cn(
            "shrink-0 rounded-[var(--zoc-radius-chip)] p-1",
            "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-[color:var(--zoc-agent-strong)]",
            className,
          )}
          style={{ color: "var(--zoc-text-muted)" }}
        >
          <MoreVertical aria-hidden className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-zoc-chat-menu-panel="">
        {overflow}
        {onOpenRules === undefined ? null : (
          <DropdownMenuItem data-zoc-menu-action="rules" onSelect={onOpenRules}>
            <ScrollText aria-hidden className="mr-2 size-3.5" />
            Rules and steering
          </DropdownMenuItem>
        )}
        {onCompact === undefined ? null : (
          <DropdownMenuItem data-zoc-menu-action="compact" onSelect={onCompact}>
            <Scissors aria-hidden className="mr-2 size-3.5" />
            Compact conversation
          </DropdownMenuItem>
        )}
        {onRestartRuntime === undefined ? null : (
          <DropdownMenuItem data-zoc-menu-action="restart-runtime" onSelect={onRestartRuntime}>
            <RotateCcw aria-hidden className="mr-2 size-3.5" />
            Restart agent runtime
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
