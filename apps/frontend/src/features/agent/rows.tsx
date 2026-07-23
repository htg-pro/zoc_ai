/**
 * rows.tsx — Cursor-style Event_Row components for the Agent Panel run feed.
 *
 * Each row renders as a timeline activity item:
 *   [icon col] [content col]
 *
 * Icon reflects step type; animated spinner while active, check when done.
 * Collapsible details expand inline without breaking flow.
 */
import { useRef, useState } from "react";
import type { ComponentType } from "react";
import type { AgentEvents } from "@zoc-studio/shared-types";
import {
  Brain,
  CheckCircle2,
  ChevronRight,
  FileSearch,
  FilePen,
  Lightbulb,
  ListChecks,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Terminal,
  XCircle,
} from "lucide-react";
import { postAgentDecision } from "./gateway-client";
import { cn } from "@/lib/utils";

type EventType = AgentEvents.EventType;

export interface RowProps<E> {
  event: E;
}

/* ── Layout primitives ─────────────────────────────────────────────────── */

/** Wrapper: left icon + right content in a timeline row. */
function TimelineRow({
  icon,
  iconColor = "text-[#71717A]",
  iconBg = "bg-[#18181f]",
  label,
  labelColor = "text-[#A1A1AA]",
  meta,
  children,
  collapsible = false,
  defaultOpen = false,
  "data-event-type": eventType,
  spinning = false,
}: {
  icon: React.ReactNode;
  iconColor?: string;
  iconBg?: string;
  label: string;
  labelColor?: string;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  "data-event-type"?: string;
  spinning?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      className="flex gap-2.5 animate-fade-row group"
      data-event-type={eventType}
    >
      <div className="flex flex-col items-center shrink-0">
        <div
          className={cn(
            "mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border border-[#26262B]/80",
            iconBg,
            iconColor,
          )}
        >
          {spinning ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            icon
          )}
        </div>
        {children && <div className="mt-1 w-px flex-1 bg-[#26262B]/60 min-h-[6px]" />}
      </div>

      <div className="flex-1 min-w-0 pb-1">
        <div
          className={cn(
            "flex items-center gap-2 min-h-5",
            collapsible && "cursor-pointer select-none",
          )}
          onClick={collapsible ? () => setOpen((o) => !o) : undefined}
        >
          <span className={cn("text-[12px] font-medium leading-none", labelColor)}>
            {label}
          </span>
          {meta && <span className="flex-1 min-w-0 truncate text-[11px] text-[#52525B]">{meta}</span>}
          {collapsible && (
            <ChevronRight
              className={cn(
                "h-3 w-3 shrink-0 text-[#52525B] transition-transform duration-150",
                open && "rotate-90",
              )}
            />
          )}
        </div>

        {children && (!collapsible || open) && (
          <div className="mt-1.5">{children}</div>
        )}
      </div>
    </div>
  );
}

/** Code/mono block used for diffs and command output. */
function CodeBlock({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "overflow-x-auto rounded-md border border-[#1E1E23] bg-[#0b0e14] p-2.5 font-mono text-[11.5px] leading-snug text-[#A1A1AA]",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/** Diff with +/- line coloring. */
function DiffBlock({ diff }: { diff: string }) {
  const lines = diff.split("\n").slice(0, 140);
  return (
    <pre className="overflow-x-auto rounded-md border border-[#1E1E23] bg-[#0b0e14] p-2.5 font-mono text-[11.5px] leading-snug max-h-52 overflow-y-auto">
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            "block",
            line.startsWith("+") && !line.startsWith("+++")
              ? "text-[#4ade80] bg-[#4ade80]/5"
              : line.startsWith("-") && !line.startsWith("---")
                ? "text-[#f87171] bg-[#f87171]/5"
                : line.startsWith("@@")
                  ? "text-[#60a5fa]"
                  : "text-[#71717A]",
          )}
        >
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

/* ── Event_Row components ──────────────────────────────────────────────── */

export function IntentRow({ event }: RowProps<AgentEvents.IntentEvent>): JSX.Element {
  return (
    <TimelineRow
      icon={<Lightbulb className="h-3 w-3" />}
      iconColor="text-[var(--zoc-ember)]"
      iconBg="bg-[rgba(251,146,60,0.12)]"
      label={event.text}
      labelColor="text-[#C8C8CE]"
      data-event-type="intent"
      meta={
        <span className="inline-flex items-center gap-1">
          <span className="rounded px-1 py-px text-[10px] border border-[#26262B] bg-[#15151A] font-mono text-[#71717A]">
            {event.modelTier}
          </span>
          <span className="rounded px-1 py-px text-[10px] border border-[#26262B] bg-[#15151A] font-mono text-[#71717A]">
            {event.contextWindowTokens}tok
          </span>
          {event.fallbackReason !== undefined && (
            <span className="rounded px-1 py-px text-[10px] border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]">
              fallback
            </span>
          )}
        </span>
      }
    />
  );
}

export function ThinkingRow({ event }: RowProps<AgentEvents.ThinkingEvent>): JSX.Element {
  return (
    <TimelineRow
      icon={<Brain className="h-3 w-3" />}
      iconColor="text-[var(--zoc-agent)]"
      iconBg="bg-[rgba(139,124,246,0.12)]"
      label="Thinking"
      labelColor="text-[#8b7cf6]"
      collapsible
      defaultOpen={false}
      data-event-type="thinking"
    >
      <p className="text-[12px] leading-relaxed text-[#71717A] italic pl-0.5">
        {event.text}
      </p>
    </TimelineRow>
  );
}

export function PlanRow({ event }: RowProps<AgentEvents.PlanEvent>): JSX.Element {
  return (
    <TimelineRow
      icon={<ListChecks className="h-3 w-3" />}
      iconColor="text-[var(--zoc-agent)]"
      iconBg="bg-[rgba(139,124,246,0.12)]"
      label="Plan"
      labelColor="text-[#8b7cf6]"
      collapsible
      defaultOpen
      data-event-type="plan"
    >
      <div className="flex flex-col gap-1">
        {event.items.map((item) => (
          <div key={item.id} className="flex items-center gap-2 text-[12px]">
            {item.status === "done" ? (
              <CheckCircle2 className="h-3 w-3 shrink-0 text-[var(--zoc-success)]" />
            ) : item.status === "active" ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-[var(--zoc-agent)]" />
            ) : (
              <span className="h-3 w-3 shrink-0 rounded-full border border-[#3F3F46]" />
            )}
            <span
              className={cn(
                "text-[12px]",
                item.status === "done"
                  ? "line-through text-[#52525B]"
                  : item.status === "active"
                    ? "text-[#D4D4D8] font-medium"
                    : "text-[#71717A]",
              )}
            >
              {item.label}
            </span>
          </div>
        ))}
      </div>
    </TimelineRow>
  );
}

export function PlanUpdateRow({ event }: RowProps<AgentEvents.PlanUpdateEvent>): JSX.Element {
  return (
    <TimelineRow
      icon={<RefreshCw className="h-3 w-3" />}
      iconColor="text-[var(--zoc-agent)]"
      iconBg="bg-[rgba(139,124,246,0.10)]"
      label="Plan update"
      labelColor="text-[#8b7cf6]"
      meta={`${event.id} → ${event.status}`}
      data-event-type="plan-update"
    />
  );
}

export function MapFilesRow({ event }: RowProps<AgentEvents.MapFilesEvent>): JSX.Element {
  const reads = event.readList.length;
  const writes = event.writeList.length;
  return (
    <TimelineRow
      icon={<ListChecks className="h-3 w-3" />}
      iconColor="text-[var(--zoc-info)]"
      iconBg="bg-[rgba(96,165,250,0.10)]"
      label="File scope"
      labelColor="text-[var(--zoc-info)]"
      meta={`${reads} read · ${writes} write`}
      collapsible
      defaultOpen
      data-event-type="map-files"
    >
      <div className="flex flex-col gap-2 text-[11.5px]">
        <div>
          <div className="mb-1 font-medium text-[#A1A1AA]">Read</div>
          {reads === 0 ? (
            <div className="text-[#52525B]">No files selected</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {event.readList.map((path, index) => (
                <div key={`read:${path}:${index}`} className="rounded border border-[#1E1E23] bg-[#0f0f14] px-2 py-1 font-mono text-[#C8C8CE]">
                  {path}
                </div>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 font-medium text-[#A1A1AA]">Create or modify</div>
          {writes === 0 ? (
            <div className="text-[#52525B]">No writes declared</div>
          ) : (
            <div className="flex flex-col gap-0.5">
              {event.writeList.map((path, index) => (
                <div key={`write:${path}:${index}`} className="rounded border border-[#1E1E23] bg-[#0f0f14] px-2 py-1 font-mono text-[#C8C8CE]">
                  {path}
                </div>
              ))}
            </div>
          )}
        </div>
        {event.rationale && (
          <p className="leading-relaxed text-[#71717A]">{event.rationale}</p>
        )}
      </div>
    </TimelineRow>
  );
}

export function ReadFilesRow({ event }: RowProps<AgentEvents.ReadFilesEvent>): JSX.Element {
  const single = event.files.length === 1;
  return (
    <TimelineRow
      icon={<FileSearch className="h-3 w-3" />}
      iconColor="text-[var(--zoc-info)]"
      iconBg="bg-[rgba(96,165,250,0.10)]"
      label={single ? "Read" : `Read ${event.files.length} files`}
      labelColor="text-[var(--zoc-info)]"
      collapsible
      defaultOpen
      data-event-type="read-files"
    >
      <div className="flex flex-col gap-0.5">
        {event.files.map((file, i) => (
          <div key={`${file.path}:${i}`} className="flex items-baseline gap-1 rounded px-2 py-1 bg-[#0f0f14] border border-[#1E1E23]">
            <span className="font-mono text-[11.5px] text-[#C8C8CE] truncate flex-1 min-w-0">{file.path}</span>
            {file.span != null && (
              <span className="shrink-0 font-mono text-[10px] text-[#52525B]">
                :{file.span[0]}–{file.span[1]}
              </span>
            )}
          </div>
        ))}
      </div>
    </TimelineRow>
  );
}

export function EditFileRow({ event }: RowProps<AgentEvents.EditFileEvent>): JSX.Element {
  return (
    <TimelineRow
      icon={<FilePen className="h-3 w-3" />}
      iconColor="text-[var(--zoc-ember)]"
      iconBg="bg-[rgba(251,146,60,0.10)]"
      label="Edit"
      labelColor="text-[var(--zoc-ember)]"
      meta={<span className="font-mono text-[11px] text-[#A1A1AA]">{event.path}</span>}
      collapsible
      defaultOpen={false}
      data-event-type="edit-file"
    >
      <DiffBlock diff={event.diff} />
    </TimelineRow>
  );
}

export function CommandRow({ event }: RowProps<AgentEvents.CommandEvent>): JSX.Element {
  const exitOk = event.exitCode === 0;
  const hasResult = event.exitCode !== undefined || event.errorTag !== undefined;
  return (
    <TimelineRow
      icon={<Terminal className="h-3 w-3" />}
      iconColor="text-[var(--zoc-info)]"
      iconBg="bg-[rgba(96,165,250,0.10)]"
      label="Run"
      labelColor="text-[var(--zoc-info)]"
      meta={
        <span className="font-mono text-[11px] text-[#A1A1AA] truncate">{event.command}</span>
      }
      collapsible={hasResult}
      defaultOpen={!exitOk && hasResult}
      data-event-type="command"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <CodeBlock className="flex-1 min-w-0">
          <span className="text-[#60a5fa] select-none mr-1">$</span>
          {event.command}
        </CodeBlock>
        {event.exitCode !== undefined && (
          <span
            className={cn(
              "shrink-0 rounded-md px-2 py-0.5 text-[11px] font-mono font-medium border",
              exitOk
                ? "border-[var(--zoc-success)]/35 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]"
                : "border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]",
            )}
          >
            exit {event.exitCode}
          </span>
        )}
        {event.errorTag !== undefined && (
          <span className="shrink-0 rounded-md border border-[var(--zoc-error)]/35 bg-[var(--zoc-error)]/10 px-2 py-0.5 text-[11px] text-[var(--zoc-error)]">
            {event.errorTag}
          </span>
        )}
      </div>
    </TimelineRow>
  );
}

export function ReviewRow({ event }: RowProps<AgentEvents.ReviewEvent>): JSX.Element {
  const adds = event.files.reduce((s, f) => s + f.adds, 0);
  const dels = event.files.reduce((s, f) => s + f.dels, 0);
  return (
    <TimelineRow
      icon={<ShieldAlert className="h-3 w-3" />}
      iconColor="text-[var(--zoc-ember)]"
      iconBg="bg-[rgba(251,146,60,0.12)]"
      label={`Review — ${event.files.length} file${event.files.length === 1 ? "" : "s"}`}
      labelColor="text-[var(--zoc-ember)]"
      meta={
        <span className="flex items-center gap-1.5">
          <span className="rounded px-1 py-px text-[10px] text-[var(--zoc-success)] bg-[var(--zoc-success)]/10">+{adds}</span>
          <span className="rounded px-1 py-px text-[10px] text-[var(--zoc-error)] bg-[var(--zoc-error)]/10">-{dels}</span>
        </span>
      }
      data-event-type="review"
    />
  );
}

export function SummaryBlock({ event }: RowProps<AgentEvents.SummaryEvent>): JSX.Element {
  return (
    <TimelineRow
      icon={<Sparkles className="h-3 w-3" />}
      iconColor="text-[var(--zoc-ember)]"
      iconBg="bg-[rgba(251,146,60,0.12)]"
      label="Summary"
      labelColor="text-[var(--zoc-ember)]"
      data-event-type="summary"
    >
      <p className="text-[12.5px] leading-relaxed text-[#C8C8CE] pl-0.5">{event.text}</p>
    </TimelineRow>
  );
}

/* ── Approval ──────────────────────────────────────────────────────────── */

export type ApprovalDecision = "approve" | "reject";
export interface AgentDecisionRequest {
  runId: string;
  decision: ApprovalDecision;
}
export interface ApprovalRowProps extends RowProps<AgentEvents.ApprovalEvent> {
  onDecision?: (request: AgentDecisionRequest) => void | Promise<void>;
}

export function ApprovalRow({
  event,
  onDecision = postAgentDecision,
}: ApprovalRowProps): JSX.Element {
  const [decision, setDecision] = useState<ApprovalDecision | undefined>(
    event.decision ?? undefined,
  );
  const settledRef = useRef<boolean>(event.decision != null);
  const decided = decision !== undefined;

  async function handleDecision(choice: ApprovalDecision): Promise<void> {
    if (settledRef.current) return;
    settledRef.current = true;
    setDecision(choice);
    try {
      await onDecision({ runId: event.runId, decision: choice });
    } catch {
      settledRef.current = false;
      setDecision(undefined);
    }
  }

  return (
    <div
      className="flex gap-2.5 animate-fade-row"
      data-event-type="approval"
    >
      <div className="flex flex-col items-center shrink-0">
        <div className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border border-[var(--zoc-ember)]/40 bg-[rgba(251,146,60,0.12)] text-[var(--zoc-ember)]">
          <ShieldAlert className="h-3 w-3" />
        </div>
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-[var(--zoc-ember)]/30 bg-[rgba(251,146,60,0.06)] p-3">
        <div className="text-[12px] font-semibold text-[var(--zoc-ember)] mb-1">Approval required</div>
        <p className="text-[12.5px] text-[#C8C8CE] leading-relaxed mb-3">{event.prompt}</p>
        <div className="flex items-center gap-2">
          {decided ? (
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] font-medium border",
                decision === "approve"
                  ? "border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 text-[var(--zoc-success)]"
                  : "border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 text-[var(--zoc-error)]",
              )}
            >
              {decision === "approve" ? (
                <CheckCircle2 className="h-3.5 w-3.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              {decision === "approve" ? "Approved" : "Rejected"}
            </span>
          ) : (
            <>
              <button
                type="button"
                className="rounded-lg border border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--zoc-success)] transition-colors hover:bg-[var(--zoc-success)]/20 disabled:opacity-50"
                disabled={decided}
                onClick={() => void handleDecision("approve")}
              >
                Approve
              </button>
              <button
                type="button"
                className="rounded-lg border border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/10 px-3 py-1.5 text-[12px] font-semibold text-[var(--zoc-error)] transition-colors hover:bg-[var(--zoc-error)]/20 disabled:opacity-50"
                disabled={decided}
                onClick={() => void handleDecision("reject")}
              >
                Reject
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Done ──────────────────────────────────────────────────────────────── */

export function DoneRow({ event }: RowProps<AgentEvents.DoneEvent>): JSX.Element {
  return (
    <div className="flex gap-2.5 animate-fade-row" data-event-type="done">
      <div className="flex flex-col items-center shrink-0">
        <div
          className={cn(
            "mt-0.5 flex h-5 w-5 items-center justify-center rounded-md border",
            event.ok
              ? "border-[var(--zoc-success)]/40 bg-[var(--zoc-success)]/12 text-[var(--zoc-success)] zoc-check-pop"
              : "border-[var(--zoc-error)]/40 bg-[var(--zoc-error)]/12 text-[var(--zoc-error)]",
          )}
        >
          {event.ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-2 min-h-5">
        <span
          className={cn(
            "text-[12px] font-semibold",
            event.ok ? "text-[var(--zoc-success)]" : "text-[var(--zoc-error)]",
          )}
        >
          {event.ok ? "Completed" : "Failed"}
        </span>
        {event.reason !== undefined && (
          <span className="text-[12px] text-[#71717A] truncate">{event.reason}</span>
        )}
      </div>
    </div>
  );
}

/* ── Registry ──────────────────────────────────────────────────────────── */

export type RowEvent = Extract<AgentEvents.AgentEvent, { type: EventType }>;
export type RowComponent = ComponentType<RowProps<RowEvent>>;

export const ROW_COMPONENTS: Record<EventType, RowComponent> = {
  intent: IntentRow as RowComponent,
  thinking: ThinkingRow as RowComponent,
  plan: PlanRow as RowComponent,
  "plan-update": PlanUpdateRow as RowComponent,
  "map-files": MapFilesRow as RowComponent,
  "read-files": ReadFilesRow as RowComponent,
  "edit-file": EditFileRow as RowComponent,
  command: CommandRow as RowComponent,
  review: ReviewRow as RowComponent,
  summary: SummaryBlock as RowComponent,
  approval: ApprovalRow as RowComponent,
  done: DoneRow as RowComponent,
};

export function isRecognizedEvent(event: { type?: unknown }): event is RowEvent {
  return (
    typeof event.type === "string" &&
    Object.prototype.hasOwnProperty.call(ROW_COMPONENTS, event.type)
  );
}
