/**
 * The degraded-secrets strip — zoc-agent-chat-rebuild R14.8, task 22.8.
 *
 * Degraded_Secret_Mode means keys are held in the runtime's memory for this launch and nothing was
 * written to disk (4.1's third tier). R14.8 asks for a persistent indication, and *persistent* is the
 * requirement rather than the styling: a toast would be the wrong shape twice over, because the condition
 * lasts for the whole launch and its consequence — every key has to be entered again next time — is
 * something the user needs while deciding whether to enter one now.
 *
 * ## Why this is not dismissible
 *
 * A dismissed strip is a user who entered three keys after dismissing it and lost all three on quit. The
 * strip is one line and does not scroll away, which is the cheapest honest presentation of a fact that
 * does not change until the app restarts.
 *
 * The reason comes from `secret_backend_status`, which is specified to return a string with no path and no
 * secret in it, so it is rendered as given.
 */
import { ShieldAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SecretStatus } from "@/lib/secure-store";

export interface DegradedSecretsStripProps {
  /** Desktop_Core's backend report. Rendered only when `degraded` is true. */
  status: SecretStatus | null;
  className?: string;
}

export function DegradedSecretsStrip({ status, className }: DegradedSecretsStripProps) {
  if (status === null || !status.degraded) return null;

  return (
    <div
      role="status"
      data-zoc-degraded-secrets=""
      data-zoc-secret-backend={status.backend}
      className={cn("flex shrink-0 items-center gap-2 border-b px-3 py-1", className)}
      style={{
        backgroundColor: "var(--zoc-elev-1)",
        borderColor: "var(--zoc-border)",
        color: "var(--zoc-text-secondary)",
        fontSize: "var(--zoc-text-label)",
      }}
    >
      <ShieldAlert
        aria-hidden
        className="size-3.5 shrink-0"
        style={{ color: "var(--zoc-ember)" }}
      />
      <span className="min-w-0 break-words">
        {status.reason === null || status.reason.length === 0
          ? "Keys are held in memory for this session only and will need re-entering next launch."
          : `${status.reason} Keys are held in memory for this session only.`}
      </span>
    </div>
  );
}
