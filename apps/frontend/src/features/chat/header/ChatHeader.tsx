/**
 * The panel header — zoc-agent-chat-rebuild R11.1, R13.1, R13.9, R21.7, task 22.2.
 *
 * 48 px, one row, container-query responsive. Left to right: the mark, the session title as a switcher, the
 * model picker, the **Approval** control, the context figure, the run status pill, the menu.
 *
 * ## The collapse order, and the one control that is not in it
 *
 * Below 560 px the model name truncates to its family; below 440 px the context figure leaves the row. What
 * never collapses is Approval — R11.1 requires the active permission mode visible at all times — and the mark,
 * the pill, and the menu stay because they are the panel's identity, its state, and its escape hatch. The
 * rules live in `globals.css` beside the header's own `container-type`, following the pattern
 * `.agent-panel-header-row` already established, because Tailwind's container-query plugin is not a
 * dependency.
 *
 * Conversation_Mode has the same never-collapse guarantee under R32.1, enforced by the *composer's* own
 * container. Two containers is what makes "neither can push the other out" true by construction rather than
 * by tuning two breakpoints against each other.
 *
 * ## Why the header takes elements rather than data for two of its slots
 *
 * `contextMeter` and `brand` are passed in. The meter's figures depend on the model *and* the census and are
 * derived in one place (R12.10, 20.3); handing the header the inputs would mean a second derivation and a
 * second chance to pair a count with the wrong limit. The mark is the brand component, which has its own
 * run-state animation and its own tests.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { SessionListProps } from "@/features/sessions/SessionList";
import { ChatMenu } from "./ChatMenu";
import { ModelPicker } from "./ModelPicker";
import { PermissionModeToggle } from "./PermissionModeToggle";
import { RunStatusPill, type RunPillState } from "./RunStatusPill";
import { SessionSwitcher } from "./SessionSwitcher";
import type { ModelChoice } from "./model-catalogue";
import type { PermissionMode } from "../composer/mode-consequence";

export interface ChatHeaderProps {
  /** The Zoc mark, with its run-state animation. Passed in so the header does not own brand behaviour. */
  brand?: ReactNode;
  /** The context meter element, derived once by the panel (R12.10). */
  contextMeter?: ReactNode;

  sessionTitle: string;
  sessionList: Omit<SessionListProps, "className">;
  onNewSession?: () => void;

  models: readonly ModelChoice[];
  selectedModel: ModelChoice | null;
  onSelectModel: (model: ModelChoice) => void;
  onAddKey?: (provider: string) => void;

  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;

  runState: RunPillState;
  runElapsedMs: number;
  tokensPerSecond?: number | null;
  onCancelRun?: () => void;

  onCompact?: () => void;
  onRestartRuntime?: () => void;
  className?: string;
}

export function ChatHeader({
  brand,
  contextMeter,
  sessionTitle,
  sessionList,
  onNewSession,
  models,
  selectedModel,
  onSelectModel,
  onAddKey,
  permissionMode,
  onPermissionModeChange,
  runState,
  runElapsedMs,
  tokensPerSecond,
  onCancelRun,
  onCompact,
  onRestartRuntime,
  className,
}: ChatHeaderProps) {
  return (
    <header
      className={cn(
        "zoc-chat-header flex h-12 shrink-0 items-center gap-2 border-b px-3",
        className,
      )}
      data-zoc-chat-header=""
      style={{ backgroundColor: "var(--zoc-panel)", borderColor: "var(--zoc-border)" }}
    >
      {brand}

      <SessionSwitcher
        title={sessionTitle}
        {...(onNewSession === undefined ? {} : { onNewSession })}
        {...sessionList}
      />

      <ModelPicker
        models={models}
        selected={selectedModel}
        onSelect={onSelectModel}
        {...(onAddKey === undefined ? {} : { onAddKey })}
      />

      <span className="flex-1" />

      {/*
        Never collapsed (R11.1). Placed before the pill so that at the narrowest width the row reads
        mark · Approval · state · menu, which is the order of what a user needs to know.
      */}
      <PermissionModeToggle value={permissionMode} onChange={onPermissionModeChange} />

      {contextMeter === undefined ? null : (
        <div className="zoc-header-context flex shrink-0 items-center">{contextMeter}</div>
      )}

      <RunStatusPill
        state={runState}
        elapsedMs={runElapsedMs}
        {...(tokensPerSecond === undefined ? {} : { tokensPerSecond })}
        {...(onCancelRun === undefined ? {} : { onCancel: onCancelRun })}
      />

      <ChatMenu
        {...(onCompact === undefined ? {} : { onCompact })}
        {...(onRestartRuntime === undefined ? {} : { onRestartRuntime })}
      />
    </header>
  );
}
