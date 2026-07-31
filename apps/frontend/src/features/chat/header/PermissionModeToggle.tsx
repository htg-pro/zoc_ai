/**
 * The Approval control — zoc-agent-chat-rebuild R11.1, R11.10, task 22.2.
 *
 * Permission_Mode, in the header, on Radix `Tabs` styled as a segmented control. It stays here rather than
 * moving to the composer beside Conversation_Mode because it is a *standing policy* that outlives any
 * Session, and R11.1 requires the active mode visible at all times — which the header guarantees by never
 * scrolling.
 *
 * ## Two controls, one primitive, on purpose
 *
 * The composer's `ConversationModeControl` is also Radix `Tabs` with the same roving-tabindex model. Using a
 * different primitive to signal "different axis" would make one of them behave differently under the
 * keyboard in order to communicate something the labels already communicate. What distinguishes them is
 * label, value vocabulary, item shape, and position — all four, rather than any one.
 *
 * ## `ask` is displayed as `Confirm`, and the wire value does not change
 *
 * The mapping is `PERMISSION_MODE_LABELS` in `model-catalogue.ts`, where it can be asserted without mounting
 * this control. Display only: the value sent is `ask`.
 *
 * ## It never collapses
 *
 * The header's container query drops the model name, then the context figure, then the session title. This
 * control is not in that order at all: R11.1 makes it the one mode that must always be visible, and
 * Conversation_Mode has the same guarantee under R32.1 enforced by the composer's own container. Neither can
 * push the other out because they are in different containers.
 */
import { ShieldCheck, ShieldOff, ShieldQuestion } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { PermissionMode } from "../composer/mode-consequence";
import { PERMISSION_MODE_LABELS } from "./model-catalogue";

/** What each mode does, on the item, so the choice is explained where it is made. */
const DESCRIPTIONS: Readonly<Record<PermissionMode, string>> = {
  ask: "Ask before each change.",
  auto: "Make changes without asking. Destructive actions still ask.",
  deny: "Refuse every change. Reads and reports only.",
};

const GLYPHS: Readonly<Record<PermissionMode, typeof ShieldCheck>> = {
  ask: ShieldQuestion,
  auto: ShieldCheck,
  deny: ShieldOff,
};

/** Narrowest-permission first, matching the Mode control's own ordering. */
const ORDER: readonly PermissionMode[] = ["deny", "ask", "auto"];

export interface PermissionModeToggleProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  className?: string;
}

export function PermissionModeToggle({ value, onChange, className }: PermissionModeToggleProps) {
  return (
    <div className={cn("flex shrink-0 items-center gap-1.5", className)} data-zoc-approval-control={value}>
      <span
        style={{
          color: "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        Approval
      </span>
      <Tabs
        value={value}
        onValueChange={(next) => {
          onChange(next as PermissionMode);
        }}
      >
        <TabsList
          // The accessible name is the question the control answers.
          aria-label="Approval policy — what Zoc AI may do without asking"
          className="h-auto gap-0.5 bg-[color:var(--zoc-row-bg)] p-0.5"
        >
          {ORDER.map((mode) => {
            const Glyph = GLYPHS[mode];
            return (
              <TabsTrigger
                key={mode}
                value={mode}
                data-zoc-approval-item={mode}
                aria-label={`${PERMISSION_MODE_LABELS[mode]}. ${DESCRIPTIONS[mode]}`}
                title={DESCRIPTIONS[mode]}
                className="flex items-center gap-1 px-1.5 py-0.5 data-[state=active]:bg-[color:var(--zoc-elev-2)]"
                style={{
                  color: value === mode ? "var(--zoc-text)" : "var(--zoc-text-muted)",
                  fontSize: "var(--zoc-text-label)",
                }}
              >
                <Glyph aria-hidden className="size-3 shrink-0" />
                {PERMISSION_MODE_LABELS[mode]}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </Tabs>
    </div>
  );
}
