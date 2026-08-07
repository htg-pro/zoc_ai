/**
 * The unrecognised-discriminant row — zoc-agent-chat-rebuild R7.6, task 16.3.
 *
 * Feature: zoc-agent-chat-rebuild, task 16.3 (R7.6).
 *
 * One muted line naming the discriminant it could not render. It is the visible half of R7.6;
 * the log record is {@link ./unknown-parts.logUnknownPart} and the stream continuing is the
 * transcript row factory's `default` branch (17.1).
 *
 * **Deliberately not an error.** An unknown discriminant means the runtime is newer than the
 * renderer, which is a version skew rather than a failure: nothing went wrong, one part cannot be
 * drawn, and the Run is fine. Rendering it in `--zoc-error` with a retry control would invite a
 * user to act on something no action changes — so it is activity tier, muted, and inert.
 *
 * **It states the discriminant rather than hiding it.** "Unrecognised event" alone tells a user
 * nothing and tells a developer reading a screenshot nothing either; the discriminant is the one
 * fact that identifies which part type is missing a row.
 *
 * **The row does not log.** Logging belongs to the factory that decided this part was unknown,
 * because a row logging in an effect would log once per *mount* — and the virtualiser mounts and
 * unmounts rows as they scroll, so "once per Run" would quietly become "once per scroll".
 *
 * **`--zoc-text-muted`, not `--zoc-text-faint`.** The design's row taxonomy words this tier as
 * faint, and `features/chat/tokens.ts` overrides that for anything carrying meaning: faint
 * measures below 4.5:1 on every panel surface, and the discriminant is informational text. The
 * label glyph beside it stays faint, which is faint's one legitimate role.
 */
import { HelpCircle } from "lucide-react";

import { cn } from "@/lib/utils";

export interface UnknownPartRowProps {
  /** The `type` value that matched no arm of the row factory's switch. */
  discriminant: string;
  className?: string;
}

export function UnknownPartRow({ discriminant, className }: UnknownPartRowProps) {
  return (
    <div
      className={cn("flex items-baseline gap-1.5", className)}
      style={{ paddingLeft: "var(--zoc-rail-inset)" }}
      data-zoc-row="unknown"
      data-zoc-unknown-discriminant={discriminant}
    >
      <HelpCircle
        aria-hidden
        className="size-3 shrink-0 translate-y-[0.15em]"
        style={{ color: "var(--zoc-text-faint)" }}
      />
      <span
        style={{
          color: "var(--zoc-text-muted)",
          fontSize: "var(--zoc-text-meta)",
          lineHeight: "var(--zoc-leading-meta)",
        }}
      >
        Unrecognised event (<code className="font-mono">{discriminant}</code>)
      </span>
    </div>
  );
}
