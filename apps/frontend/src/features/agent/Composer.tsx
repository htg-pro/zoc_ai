import { useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, ShieldCheck, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { MAX_MESSAGE_LENGTH, validateMessage } from "@/lib/composer-validate";
import type { AutonomyLevel } from "@/lib/run-machine";
import { SlashAutocomplete } from "./SlashAutocomplete";
import { MentionAutocomplete } from "./MentionAutocomplete";
import { AttachmentChips } from "./AttachmentChips";
import { MessageQueue } from "./MessageQueue";
import { RulesDialog } from "./RulesDialog";
import { detectMentionQuery, applyMention } from "@/lib/context-mentions";
import { basename } from "@/lib/paths";
import { getActiveSelection } from "@/lib/editor-actions";
import { resolveSlashCommand } from "@/lib/slash-commands";

const AUTONOMY_CYCLE: AutonomyLevel[] = ["Low", "Medium", "High"];

export function Composer() {
  const value        = useApp((s) => s.input);
  const setValue     = useApp((s) => s.setInput);
  const [composing, setComposing] = useState(false);
  const send         = useApp((s) => s.sendUserMessage);
  const queueMessage = useApp((s) => s.queueUserMessage);
  const messageQueue = useApp((s) => s.messageQueue);
  const stopAndSend  = useApp((s) => s.stopAndSend);
  const streaming    = useApp((s) => s.streaming);
  const addAttachment   = useApp((s) => s.addAttachment);
  const clearAttachments = useApp((s) => s.clearAttachments);
  const cancelStream = useApp((s) => s.cancelStream);
  const activeFile   = useApp((s) => s.activeFile);
  const isRunning    = useApp((s) => s.isRunning);
  const autonomy     = useApp((s) => s.autonomy);
  const setAutonomy  = useApp((s) => s.setAutonomy);
  const reviewRunning = useApp((s) => s.reviewRunning);
  const testRunning  = useApp((s) => s.testGenRunning || s.testRunRunning);
  const agentMode    = useApp((s) => s.agentMode);
  const setAgentMode = useApp((s) => s.setAgentMode);
  const projectRules = useApp((s) => s.projectRules);

  const ref = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting]         = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [caretPos, setCaret]                = useState(0);

  const mention  = caretPos >= 0 && !value.startsWith("/") ? detectMentionQuery(value, caretPos) : null;
  const runBusy  = streaming || reviewRunning || testRunning || isRunning;
  const busy     = runBusy || submitting;
  const isAsk    = agentMode === "ask";
  const hasText  = !!value.trim();

  const cycleAutonomy = () => {
    const next = AUTONOMY_CYCLE[(AUTONOMY_CYCLE.indexOf(autonomy) + 1) % AUTONOMY_CYCLE.length];
    setAutonomy(next);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), 160)}px`;
  }, [value]);

  const submit = () => {
    const result = validateMessage(value);
    if (!result.valid) {
      setValidationError(
        result.reason === "too_long"
          ? `Message is too long (max ${MAX_MESSAGE_LENGTH.toLocaleString()} characters).`
          : "Enter a message before sending.",
      );
      return;
    }
    if (busy) {
      const content = value.trim();
      queueMessage(content);
      setValidationError(null);
      setValue("");
      return;
    }
    const content = value.trim();
    setValidationError(null);
    setSubmitting(true);
    setValue("");
    const pending = send(content);
    clearAttachments();
    void pending.finally(() => {
      setSubmitting(false);
      ref.current?.focus();
    });
  };

  const attachActiveFile = () => {
    if (!activeFile) return;
    const needsSpace = value.length > 0 && !/\s$/.test(value);
    const token = basename(activeFile) || "file";
    setValue(`${value}${needsSpace ? " " : ""}@${token}`);
    addAttachment({ label: activeFile, kind: "file", path: activeFile, token });
    ref.current?.focus();
  };

  return (
    <div className="shrink-0 border-t border-[#1A1A1F] bg-[#0C0C10] p-3" data-testid="composer">
      {/* Queued message indicator */}
      {runBusy && (
        <div className="mb-2 flex items-center gap-1.5 rounded-lg border border-[#26262B] bg-[#15151A] px-2.5 py-1.5">
          <span className="relative flex h-1.5 w-1.5 shrink-0">
            <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-[#9B6AF1]/40 opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#9B6AF1]" />
          </span>
          <span className="text-[11px] text-[#71717A]">
            {messageQueue.length > 0
              ? `${messageQueue.length} message${messageQueue.length === 1 ? "" : "s"} queued — sent when run finishes`
              : "Will be queued until the current task completes"}
          </span>
        </div>
      )}

      <MessageQueue />

      {/* Main input box */}
      <div className="relative rounded-xl border border-[#26262B] bg-[#111116] transition-colors focus-within:border-[#3F3F46]">
        <div className="px-1 pt-1">
          <div className="px-0.5">
            <AttachmentChips />
          </div>

          {value.startsWith("/") && (
            <SlashAutocomplete
              prefix={value}
              onPick={(command) => {
                const resolved = resolveSlashCommand(command, {
                  activeFile,
                  selectedCode: getActiveSelection(),
                });
                clearAttachments();
                setAgentMode(resolved.mode);
                setValue(resolved.prompt);
                if (resolved.contextFile) {
                  addAttachment({
                    label: resolved.contextFile.path,
                    kind: "file",
                    path: resolved.contextFile.path,
                    token: resolved.contextFile.token,
                  });
                }
                requestAnimationFrame(() => {
                  ref.current?.focus();
                  ref.current?.setSelectionRange(resolved.prompt.length, resolved.prompt.length);
                  setCaret(resolved.prompt.length);
                });
              }}
            />
          )}

          {mention && (
            <MentionAutocomplete
              query={mention.query}
              onClose={() => setCaret(-1)}
              onPick={(c) => {
                const token = basename(c.path) || c.label;
                const { text, caret: next } = applyMention(value, mention.start, caretPos, token);
                setValue(text);
                addAttachment({ label: c.path, kind: c.kind, path: c.path, token });
                requestAnimationFrame(() => {
                  ref.current?.focus();
                  ref.current?.setSelectionRange(next, next);
                  setCaret(next);
                });
              }}
            />
          )}

          <Textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => {
              const val = e.target.value;
              if (validationError) setValidationError(null);
              setValue(val);
              setCaret(e.target.selectionStart ?? val.length);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onCompositionStart={() => setComposing(true)}
            onCompositionEnd={() => setComposing(false)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.altKey &&
                !composing &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={isAsk ? "Ask about your code…" : "Message the agent…"}
            disabled={busy}
            data-testid="composer-textarea"
            className="max-h-40 min-h-[44px] w-full resize-none border-0 bg-transparent px-2 pb-1 pt-2 shadow-none focus-visible:ring-0 text-[13px] text-[#EDEDF0] placeholder:text-[#3F3F46]"
          />
        </div>

        {/* Bottom toolbar */}
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-1">
          {/* Mode toggle */}
          <div className="flex items-center rounded-lg border border-[#1E1E23] bg-[#0F0F14] p-0.5">
            <button
              type="button"
              onClick={() => setAgentMode("ask")}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-md font-medium transition-all",
                isAsk
                  ? "bg-[#1A3A5C] text-[#60a5fa] shadow-sm"
                  : "text-[#52525B] hover:text-[#A1A1AA]",
              )}
              title="Ask: read-only Q&A"
            >
              Ask
            </button>
            <button
              type="button"
              onClick={() => setAgentMode("agent")}
              className={cn(
                "px-2.5 py-1 text-[11px] rounded-md font-medium transition-all",
                !isAsk
                  ? "bg-[#2A1F4E] text-[#9B6AF1] shadow-sm"
                  : "text-[#52525B] hover:text-[#A1A1AA]",
              )}
              title="Agent: full autonomy"
            >
              Agent
            </button>
          </div>

          {/* Autonomy / read-only indicator */}
          {isAsk ? (
            <span
              className="flex items-center gap-1 rounded-md border border-[#60a5fa]/20 bg-[#60a5fa]/8 px-2 py-0.5 text-[10.5px] text-[#60a5fa]"
              title="Ask mode: no files will change"
            >
              Read-only
            </span>
          ) : (
            <button
              type="button"
              onClick={cycleAutonomy}
              className="flex items-center gap-1.5 rounded-md border border-[#1E1E23] bg-[#0F0F14] px-2 py-0.5 text-[10.5px] text-[#71717A] transition-colors hover:bg-[#141419]"
              title={`Autonomy: ${autonomy} — click to cycle`}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  autonomy === "High" ? "bg-[#fb923c]" : autonomy === "Medium" ? "bg-[#9B6AF1]" : "bg-[#4ade80]",
                )}
              />
              {autonomy}
            </button>
          )}

          {/* Attach file */}
          {activeFile && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-[#52525B] hover:bg-[#1E1E23] hover:text-[#A1A1AA]"
              title="Attach active file"
              onClick={attachActiveFile}
              disabled={busy}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          )}

          {/* Rules badge */}
          {projectRules?.active && (
            <RulesDialog>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-[#1E1E23] bg-[#0F0F14] px-2 py-0.5 text-[10.5px] text-[#71717A] hover:bg-[#141419] transition-colors"
                title="View project rules"
              >
                <ShieldCheck className="h-3 w-3 text-[#4ade80]" />
                Rules
              </button>
            </RulesDialog>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {streaming && hasText && (
              <button
                type="button"
                onClick={() => {
                  const content = value.trim();
                  setValue("");
                  stopAndSend(content);
                }}
                className="h-7 rounded-lg border border-[#26262B] bg-[#15151A] px-2.5 text-[11px] text-[#D4D4D8] hover:bg-[#1E1E23] transition-colors"
                title="Stop current run and send now"
              >
                Stop &amp; send
              </button>
            )}

            {streaming ? (
              <button
                type="button"
                onClick={() => cancelStream()}
                className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#f87171]/15 border border-[#f87171]/30 text-[#f87171] hover:bg-[#f87171]/25 transition-colors shadow-[0_0_12px_rgba(248,113,113,0.15)]"
                aria-label="Stop"
              >
                <Square className="h-3 w-3 fill-current" />
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={!hasText || busy}
                className={cn(
                  "flex h-7 w-7 items-center justify-center rounded-lg border transition-all",
                  hasText && !busy
                    ? "bg-[#7C3AED] border-[#9B6AF1]/30 text-white shadow-[0_0_16px_rgba(124,58,237,0.4)] hover:bg-[#6D28D9]"
                    : "border-[#26262B] bg-[#15151A] text-[#3F3F46] cursor-not-allowed",
                )}
                aria-label="Send"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Footer hint */}
      <div className="mt-1.5 px-1 text-[10.5px] text-[#3F3F46] leading-snug">
        {validationError ? (
          <span className="text-[var(--zoc-error)]" role="alert">{validationError}</span>
        ) : isAsk ? (
          "Ask mode is read-only — no files change."
        ) : (
          "Zoc can make mistakes · checkpoints let you roll back"
        )}
      </div>
    </div>
  );
}
