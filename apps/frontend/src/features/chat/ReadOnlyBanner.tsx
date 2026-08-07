/**
 * The read-only viewer banner — zoc-agent-chat-rebuild R1.4, task 22.8.
 *
 * Feature: zoc-agent-chat-rebuild, task 22.8 (R1.4).
 *
 * A viewer watching someone else's Session over the LAN share sees this and no mutating control anywhere
 * in the panel. The banner is the *explanation* for that absence: a surface with the run controls simply
 * missing and nothing saying why reads as a broken build.
 *
 * ## Why absence rather than `disabled`
 *
 * R1.4 says the controls are not offered, and the panel omits them from the DOM. A disabled button is
 * still an affordance — it is announced, it is in the tab order under some assistive tooling, and it
 * invites a click that will not work. Property 58 asserts the stronger claim, which is only assertable if
 * the elements are genuinely absent, so this component states the reason once and the panel does the
 * omitting.
 *
 * The host label is shown when the share URL carried one, because "you are watching" is a different fact
 * from "you are watching *that machine*", and a viewer with two shares open needs the second.
 */
import { Eye } from "lucide-react";

import { cn } from "@/lib/utils";

export interface ReadOnlyBannerProps {
  /** The host this window is watching, from the share URL. */
  host?: string | null;
  className?: string;
}

export function ReadOnlyBanner({ host, className }: ReadOnlyBannerProps) {
  return (
    <div
      role="status"
      data-zoc-read-only-banner=""
      className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-1.5", className)}
      style={{
        backgroundColor: "var(--zoc-elev-1)",
        borderColor: "var(--zoc-border)",
        color: "var(--zoc-text-secondary)",
        fontSize: "var(--zoc-text-label)",
      }}
    >
      <Eye aria-hidden className="size-3.5 shrink-0" style={{ color: "var(--zoc-text-faint)" }} />
      <span>
        {host === undefined || host === null || host.length === 0
          ? "Watching a shared session. You can read the transcript but not run anything."
          : `Watching ${host}. You can read the transcript but not run anything.`}
      </span>
    </div>
  );
}
