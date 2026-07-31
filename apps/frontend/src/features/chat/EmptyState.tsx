/**
 * The empty state — zoc-agent-chat-rebuild R13.2, R13.3, R18.1, task 22.8.
 *
 * What a Session with no messages shows: the mark at 40 px, one line naming what the panel is for, and
 * three starting points derived from the open workspace (`panel-state.ts`).
 *
 * ## Why a missing key replaces the suggestions rather than sitting beside them
 *
 * R13.2 and R13.3 make key presence the submission gate, so with a cloud model selected and no key every
 * chip here is a button that cannot work. Offering all three beside a warning would be offering three
 * dead ends and one live one; the substitution makes the single available action the only one on screen.
 * The gate itself is `isSubmittable`, shared with the send control, so the empty state and the composer
 * cannot disagree about whether a Run could start.
 *
 * ## Why the chips insert rather than submit
 *
 * A chip fills the composer and leaves the caret there. The prompt is a starting point — the user
 * usually adds a file mention or narrows the question — and a chip that sent immediately would make the
 * common case "cancel the Run I did not mean to start".
 */
import { KeyRound } from "lucide-react";

import { cn } from "@/lib/utils";
import { ZocMark } from "./brand/ZocMark";
import { gateReasonOf, isSubmittable, type ModelChoice } from "./header/model-catalogue";
import { suggestionsFor } from "./panel-state";

export interface EmptyStateProps {
  workspaceRoot: string | null;
  /** The selected model. A cloud model with no key replaces the suggestions with key entry. */
  model: ModelChoice | null;
  /** Puts a suggestion in the composer. Never submits it. */
  onPick: (prompt: string) => void;
  /** Opens key entry for the blocked provider (R13.3). Absent for a read-only viewer. */
  onAddKey?: (provider: string) => void;
  className?: string;
}

export function EmptyState({
  workspaceRoot,
  model,
  onPick,
  onAddKey,
  className,
}: EmptyStateProps) {
  const blocked = model !== null && !isSubmittable(model);

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6", className)}
      data-zoc-empty-state=""
    >
      <ZocMark size={40} state="idle" title="Zoc AI" />

      <p
        data-zoc-empty-prompt=""
        className="text-center"
        style={{
          color: "var(--zoc-text-secondary)",
          fontSize: "var(--zoc-text-body)",
          lineHeight: "var(--zoc-leading-body)",
        }}
      >
        {blocked
          ? gateReasonOf(model)
          : "Ask about this workspace, or describe a change and review it before it lands."}
      </p>

      {blocked ? (
        onAddKey === undefined ? null : (
          <button
            type="button"
            data-zoc-empty-add-key=""
            onClick={() => {
              onAddKey(model.provider);
            }}
            className="inline-flex items-center gap-1.5 rounded-[var(--zoc-radius-chip)] border px-2.5 py-1.5 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
            style={{
              borderColor: "var(--zoc-agent-strong)",
              color: "var(--zoc-text)",
              fontSize: "var(--zoc-text-label)",
            }}
          >
            <KeyRound aria-hidden className="size-3.5" />
            {`Add a ${model.providerLabel} key`}
          </button>
        )
      ) : (
        <ul
          role="list"
          data-zoc-empty-suggestions=""
          className="flex flex-wrap items-center justify-center gap-2"
        >
          {suggestionsFor(workspaceRoot).map((suggestion) => (
            <li key={suggestion.id}>
              <button
                type="button"
                data-zoc-empty-suggestion={suggestion.id}
                onClick={() => {
                  onPick(suggestion.prompt);
                }}
                className="rounded-[var(--zoc-radius-chip)] border px-2.5 py-1 hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--zoc-agent-strong)]"
                style={{
                  backgroundColor: "var(--zoc-elev-1)",
                  borderColor: "var(--zoc-border)",
                  color: "var(--zoc-text-secondary)",
                  fontSize: "var(--zoc-text-label)",
                }}
              >
                {suggestion.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
