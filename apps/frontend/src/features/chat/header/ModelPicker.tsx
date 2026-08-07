/**
 * The model picker — zoc-agent-chat-rebuild R13.1, R13.2, R13.3, R13.6, R13.11, R13.12, R13.13, task 22.2.
 *
 * Feature: zoc-agent-chat-rebuild, task 22.2 (R13.1, R13.2, R13.3, R13.6, R13.11, R13.12).
 *
 * Radix `Popover` plus `cmdk`, models grouped by provider, one row per model carrying three facts and no
 * more: whether its provider has a key, how fast it has been, and — for a local model — whether it fits this
 * machine.
 *
 * ## The key badge is derived from `hasKey` alone
 *
 * Nothing else: not a validity probe, not the last Run's outcome. See `model-catalogue.ts` for why, and
 * Property 30 for the assertion. Selecting a keyless cloud model is *allowed* — the picker is not a gate —
 * and it is the send path that blocks, with the reason and a direct route to key entry. Refusing the
 * selection instead would leave a user unable to see which models they could use if they added a key.
 *
 * ## Why the badge and the route are two elements
 *
 * R13.2 is a report and R13.3 is an affordance, and one button doing both is only correct while every host
 * can act on it. A read-only viewer cannot: `ChatPanel` withholds `onAddKey` from a viewer, so the row
 * renders the badge as inert text instead. Rendering the button with an optional handler was the shape
 * that hid this — it produced a control that looked live to the one user who can never use it.
 *
 * ## What the picker does not show
 *
 * Resident memory, video memory, layer counts. R13.13 keeps those in the status bar, and the fit state is the
 * one hardware fact that changes which model a user picks. A model with no benchmark history shows no rate
 * at all rather than a dash (R13.12) — a placeholder reads as a measurement of zero.
 */
import { Check, HardDrive, KeyRound } from "lucide-react";

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  FIT_LABELS,
  formatMeanRate,
  groupByProvider,
  keyBadgeOf,
  type ModelChoice,
} from "./model-catalogue";

export interface ModelPickerProps {
  models: readonly ModelChoice[];
  /** The selected model, or `null` before a Session has one. */
  selected: ModelChoice | null;
  onSelect: (model: ModelChoice) => void;
  /** Opens Settings → Providers at the row for a provider (R13.3). */
  onAddKey?: (provider: string) => void;
  className?: string;
}

export function ModelPicker({ models, selected, onSelect, onAddKey, className }: ModelPickerProps) {
  const groups = groupByProvider(models);

  return (
    // `modal` is what makes R21.6 true rather than half true. A Radix Popover left at its default is
    // non-modal: it moves focus in on open and returns it to the trigger on dismissal, but Tab walks
    // straight out of it into the page behind. R21.6 asks for a trap, and the picker is a list the user
    // arrows through — leaving it mid-list lands focus somewhere with no relationship to the task.
    <Popover modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-zoc-model-picker={selected?.modelId ?? ""}
          aria-label={
            selected === null
              ? "Choose a model"
              : `Model: ${selected.label} from ${selected.providerLabel}`
          }
          className={cn(
            "flex min-w-0 items-center gap-1 rounded-[var(--zoc-radius-chip)] px-1.5 py-0.5",
            "hover:bg-[var(--zoc-row-bg)] focus-visible:outline-none focus-visible:ring-2",
            "focus-visible:ring-[color:var(--zoc-agent-strong)]",
            className,
          )}
          style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-label)" }}
        >
          {/* Truncated first under the header's container query — see `ChatHeader`. */}
          <span className="zoc-header-model-name truncate">
            {selected?.label ?? "Choose a model"}
          </span>
          {selected !== null && keyBadgeOf(selected) !== null ? (
            <KeyRound
              aria-hidden
              className="size-3 shrink-0"
              style={{ color: "var(--zoc-ember)" }}
            />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-96 p-0"
        data-zoc-model-popover=""
        style={{ backgroundColor: "var(--zoc-elev-2)", borderColor: "var(--zoc-border)" }}
      >
        <Command>
          <CommandInput placeholder="Search models" data-zoc-model-search="" />
          <CommandList className="max-h-80">
            <CommandEmpty>No model matches that.</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.provider}
                heading={group.providerLabel}
                data-zoc-model-group={group.provider}
              >
                {group.models.map((model) => {
                  const rate = formatMeanRate(model);
                  const badge = keyBadgeOf(model);
                  return (
                    <CommandItem
                      key={`${model.provider}:${model.modelId}`}
                      value={`${model.providerLabel} ${model.label} ${model.modelId}`}
                      data-zoc-model-item={model.modelId}
                      data-zoc-model-key-badge={badge ?? undefined}
                      onSelect={() => {
                        onSelect(model);
                      }}
                      className="flex items-baseline gap-2"
                    >
                      {selected?.modelId === model.modelId &&
                      selected.provider === model.provider ? (
                        <Check
                          aria-hidden
                          className="size-3 shrink-0"
                          style={{ color: "var(--zoc-agent)" }}
                        />
                      ) : (
                        <span className="size-3 shrink-0" />
                      )}
                      <span
                        className="min-w-0 flex-1 truncate"
                        style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-meta)" }}
                      >
                        {model.label}
                      </span>

                      {/* R13.6, R13.13: the fit state, and no other hardware fact. */}
                      {model.local && model.fit !== undefined ? (
                        <span
                          className="flex shrink-0 items-center gap-1"
                          data-zoc-model-fit={model.fit}
                          style={{
                            color:
                              model.fit === "exceeds"
                                ? "var(--zoc-error)"
                                : model.fit === "tight"
                                  ? "var(--zoc-ember)"
                                  : "var(--zoc-text-muted)",
                            fontSize: "var(--zoc-text-label)",
                          }}
                        >
                          <HardDrive aria-hidden className="size-3" />
                          {FIT_LABELS[model.fit]}
                        </span>
                      ) : null}

                      {/*
                        R13.11's mean rate, and R13.12's empty slot: a model with no recorded history gets no
                        element at all rather than a dash.
                      */}
                      {rate === null ? null : (
                        <span
                          className="shrink-0 tabular-nums"
                          data-zoc-model-rate=""
                          style={{
                            color: "var(--zoc-text-faint)",
                            fontSize: "var(--zoc-text-label)",
                          }}
                        >
                          {rate}
                        </span>
                      )}

                      {badge === null ? null : onAddKey === undefined ? (
                        /*
                          The report without the route: R13.2 without R13.3, which is the read-only
                          viewer's case. `ChatPanel` withholds `onAddKey` from a viewer deliberately —
                          nobody opens Settings on someone else's machine — and a button that calls
                          nothing is an invitation to press it twice and conclude the app is broken. The
                          badge stays, because which providers lack a key is what the picker is for.
                        */
                        <span
                          className="flex shrink-0 items-center gap-1"
                          data-zoc-model-key-missing=""
                          style={{ color: "var(--zoc-ember)", fontSize: "var(--zoc-text-label)" }}
                        >
                          <KeyRound aria-hidden className="size-3" />
                          {/* Said in a word as well as a colour and a glyph (R21.7). */}
                          No key
                        </span>
                      ) : (
                        <button
                          type="button"
                          data-zoc-model-add-key={model.provider}
                          // A route to fixing it, on the row that reports it (R13.3). Not a disabled row:
                          // the model is selectable, and it is the send that blocks.
                          aria-label={`Add an API key for ${model.providerLabel}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            onAddKey(model.provider);
                          }}
                          className="shrink-0 rounded-[var(--zoc-radius-chip)] px-1 py-0.5 underline decoration-dotted"
                          style={{ color: "var(--zoc-ember)", fontSize: "var(--zoc-text-label)" }}
                        >
                          Add key
                        </button>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
