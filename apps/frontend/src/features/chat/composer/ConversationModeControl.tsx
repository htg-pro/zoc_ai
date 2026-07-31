/**
 * The Conversation_Mode control — zoc-agent-chat-rebuild R11.10, R32.1, R32.2, task 20.2.
 *
 * `Ask` / `Plan` / `Agent`, leftmost in the composer's control row, labelled **Mode**. Radix `Tabs`
 * styled as a segmented control — the same primitive and the same roving-tabindex model the header's
 * Approval control uses, deliberately: the two axes are siblings, and using a different primitive to
 * signal "different axis" would make one of them behave differently under the keyboard in order to
 * communicate something the labels already say.
 *
 * ## Why the shapes come from the timeline
 *
 * Hollow circle, list glyph, filled circle — the vocabulary the tool timeline already teaches, where a
 * hollow circle is a read and a filled one is a write. So the control says what each mode *does* in a
 * language the transcript has been teaching since the first Run, and R21.7 holds without colour.
 *
 * ## Why it is never hidden
 *
 * R32.1 requires the active Conversation_Mode to be visible at all times. Below 340 px the items drop
 * their text and keep their shapes (the container rule in `globals.css`), which is a narrower control
 * rather than an absent one — collapsing into a menu would satisfy the layout and break the requirement.
 *
 * ## Why the mode is submitted from here and nowhere else
 *
 * R32.2 retires `routeModeForPrompt`, the prompt-text inspection that rewrote a selected `agent` to `ask`.
 * The mode the Run executes is the mode this control holds, and Property 75 asserts it against drafts
 * seeded with that router's own trigger vocabulary.
 */
import { Circle, CircleDot, List } from "lucide-react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { ConversationMode } from "@zoc-studio/shared-types";

interface ModeItem {
  readonly mode: ConversationMode;
  readonly label: string;
  /** One sentence, on the item itself, so the choice is explained where it is made. */
  readonly description: string;
  readonly Glyph: typeof Circle;
}

/**
 * The three items, narrowest capability first.
 *
 * Ordered by what each mode may attempt rather than by frequency of use: a control whose left end is the
 * safest option is one a user can reason about, and it matches the Approval control's own ordering.
 */
const ITEMS: readonly ModeItem[] = [
  {
    mode: "ask",
    label: "Ask",
    description: "Answers questions and reads files. Changes nothing.",
    // Hollow: the timeline's read shape.
    Glyph: Circle,
  },
  {
    mode: "plan",
    label: "Plan",
    description: "Proposes a plan for you to review before anything changes.",
    Glyph: List,
  },
  {
    mode: "agent",
    label: "Agent",
    description: "Works on its own, within the approval settings.",
    // Filled: the timeline's write shape.
    Glyph: CircleDot,
  },
];

export interface ConversationModeControlProps {
  value: ConversationMode;
  onChange: (mode: ConversationMode) => void;
  className?: string;
}

export function ConversationModeControl({
  value,
  onChange,
  className,
}: ConversationModeControlProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)} data-zoc-mode-control="">
      <span
        // A visible label, not a placeholder: two three-value controls in one row need naming, and
        // "Mode" beside "Approval" is what tells a user they are different axes.
        id="zoc-conversation-mode-label"
        style={{
          color: "var(--zoc-text-faint)",
          fontSize: "var(--zoc-text-label)",
          letterSpacing: "var(--zoc-tracking-label)",
        }}
      >
        Mode
      </span>
      <Tabs
        value={value}
        onValueChange={(next) => {
          onChange(next as ConversationMode);
        }}
      >
        <TabsList
          // The accessible name is the question the control answers, rather than its own noun.
          aria-label="Conversation mode — what Zoc AI may attempt this turn"
          className="h-auto gap-0.5 bg-[color:var(--zoc-row-bg)] p-0.5"
        >
          {ITEMS.map((item) => (
            <TabsTrigger
              key={item.mode}
              value={item.mode}
              data-zoc-mode-item={item.mode}
              // The description rides on the item, so the difference between the three is readable at the
              // point of choosing rather than in a tooltip nobody opens.
              aria-label={`${item.label}. ${item.description}`}
              title={item.description}
              className={cn(
                "flex items-center gap-1 px-1.5 py-0.5",
                "data-[state=active]:bg-[color:var(--zoc-elev-2)]",
              )}
              style={{
                color: value === item.mode ? "var(--zoc-text)" : "var(--zoc-text-muted)",
                fontSize: "var(--zoc-text-label)",
              }}
            >
              <item.Glyph aria-hidden className="size-3 shrink-0" />
              {/* Dropped below 340px by the container rule; the shape stays (R32.1). */}
              <span className="zoc-mode-item-text">{item.label}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}
