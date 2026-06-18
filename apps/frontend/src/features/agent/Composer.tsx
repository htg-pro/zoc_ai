import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, ShieldCheck, Square } from "lucide-react";
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

const AUTONOMY_CYCLE: AutonomyLevel[] = ["Low", "Medium", "High"];

export function Composer() {
  const value = useApp((s) => s.input);
  const setValue = useApp((s) => s.setInput);
  const [composing, setComposing] = useState(false);
  const send = useApp((s) => s.sendUserMessage);
  const queueMessage = useApp((s) => s.queueUserMessage);
  const messageQueue = useApp((s) => s.messageQueue);
  const stopAndSend = useApp((s) => s.stopAndSend);
  const streaming = useApp((s) => s.streaming);
  const addAttachment = useApp((s) => s.addAttachment);
  const clearAttachments = useApp((s) => s.clearAttachments);
  const cancelStream = useApp((s) => s.cancelStream);
  const activeFile = useApp((s) => s.activeFile);
  const isRunning = useApp((s) => s.isRunning);
  const autonomy = useApp((s) => s.autonomy);
  const setAutonomy = useApp((s) => s.setAutonomy);
  const reviewRunning = useApp((s) => s.reviewRunning);
  const testRunning = useApp((s) => s.testGenRunning || s.testRunRunning);
  const agentMode = useApp((s) => s.agentMode);
  const setAgentMode = useApp((s) => s.setAgentMode);
  const projectRules = useApp((s) => s.projectRules);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [caretPos, setCaret] = useState(0);
  const mention = caretPos >= 0 && !value.startsWith("/") ? detectMentionQuery(value, caretPos) : null;
  const runBusy = streaming || reviewRunning || testRunning || isRunning;
  const busy = runBusy || submitting;

  const cycleAutonomy = () => {
    const next =
      AUTONOMY_CYCLE[(AUTONOMY_CYCLE.indexOf(autonomy) + 1) % AUTONOMY_CYCLE.length];
    setAutonomy(next);
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 48), 160)}px`;
  }, [value]);

  const submit = () => {
    // R4.13: reject empty/whitespace-only (and over-limit) input with feedback.
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
      // A run is in flight — hold this message and release it automatically
      // when the run finishes (R4.11 / R4.14). Clear the composer so the user
      // sees it was accepted.
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
    clearAttachments();
    void send(content).finally(() => {
      setSubmitting(false);
      ref.current?.focus();
    });
  };

  const attachActiveFile = () => {
    if (!activeFile) return;
    const needsSpace = value.length > 0 && !/\s$/.test(value);
    setValue(`${value}${needsSpace ? " " : ""}@file`);
    addAttachment({ label: activeFile, kind: "file" });
    ref.current?.focus();
  };

  const isAsk = agentMode === "ask";

  return (
    <div
      className="shrink-0 border-t border-[#1E1E23] bg-[#101014] p-3"
      data-testid="composer"
    >
      <div className="rounded-[10px] bg-[#131318] border border-[#26262B] p-2.5">
        {runBusy && (
          <div className="mb-2 inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--border-muted))] bg-accent px-2 py-1">
            <span className="relative flex h-1.5 w-1.5 items-center justify-center">
              <span className="absolute inline-flex h-2.5 w-2.5 animate-ping rounded-full bg-primary/40 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
            </span>
            <span className="text-[11px] text-muted-foreground">
              {messageQueue.length > 0
                ? `${messageQueue.length} message${messageQueue.length === 1 ? "" : "s"} queued — sent as the run completes`
                : "Will be queued until the current task completes"}
            </span>
          </div>
        )}

        <MessageQueue />

        <div className="px-0.5">
          <AttachmentChips />
        </div>

        {value.startsWith("/") && (
          <SlashAutocomplete
            prefix={value}
            onPick={(c) => {
              setValue("/" + c.name + " ");
              ref.current?.focus();
            }}
          />
        )}

        {mention && (
          <MentionAutocomplete
            query={mention.query}
            onClose={() => setCaret(-1)}
            onPick={(c) => {
              const { text, caret: next } = applyMention(value, mention.start, caretPos, c.path);
              setValue(text);
              addAttachment({ label: c.path, kind: c.kind });
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
          className="max-h-40 min-h-10 resize-none border-0 bg-transparent px-0.5 pb-2 pt-0 shadow-none focus-visible:ring-0 text-[12.5px] text-[#FAFAFA] placeholder:text-[#52525B]"
        />

        <div className="mt-2.5 flex items-center gap-2">
          {activeFile && (
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-[#71717A] hover:bg-muted hover:text-foreground shrink-0"
              aria-label="Attach active file"
              title="Attach active file"
              onClick={attachActiveFile}
              disabled={busy}
            >
              <Paperclip className="h-3.5 w-3.5" />
            </Button>
          )}

          {projectRules?.active && (
            <RulesDialog>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-[#26262B] bg-[#1B1B21] px-2 py-0.5 text-[10.5px] text-[#A1A1AA] shrink-0 hover:bg-[#26262B]"
                title="View project rules applied to every run"
              >
                <ShieldCheck className="h-3 w-3 text-emerald-400" />
                Rules
              </button>
            </RulesDialog>
          )}

          <div className="flex items-center bg-[#1B1B21] rounded-full p-0.5 shrink-0 border border-[#26262B]">
            <button
              type="button"
              onClick={() => setAgentMode("ask")}
              className={cn(
                "px-3 py-0.5 text-[11px] rounded-full font-semibold transition-all",
                isAsk
                  ? "text-[#0b0e14] bg-[var(--zoc-info)] shadow-sm"
                  : "text-[#71717A] hover:text-[#A1A1AA]"
              )}
              title="Ask: read-only Q&A about your code"
            >
              Ask
            </button>
            <button
              type="button"
              onClick={() => setAgentMode("agent")}
              className={cn(
                "px-3 py-0.5 text-[11px] rounded-full font-semibold transition-all",
                !isAsk
                  ? "text-[#0b0e14] bg-[var(--zoc-ember)] shadow-sm"
                  : "text-[#71717A] hover:text-[#A1A1AA]"
              )}
              title="Agent: full autonomy — can edit files and run commands"
            >
              Agent
            </button>
          </div>

          {isAsk ? (
            <span
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border border-[var(--zoc-info)]/40 bg-[var(--zoc-info)]/10 shrink-0"
              title="Ask mode is read-only — no files change"
              aria-label="Read-only mode"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--zoc-info)]" />
              <span className="text-[11px] text-[#A1A1AA]">Read-only</span>
            </span>
          ) : (
            <button
              type="button"
              onClick={cycleAutonomy}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border border-[#26262B] bg-[#15151A] shrink-0 hover:bg-[#1B1B21] transition-colors"
              title={`Autonomy: ${autonomy} (click to change)`}
              aria-label={`Autonomy level: ${autonomy}`}
            >
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full",
                  autonomy === "High"
                    ? "bg-warning"
                    : autonomy === "Medium"
                      ? "bg-primary"
                      : "bg-success",
                )}
              ></span>
              <span className="text-[11px] text-[#A1A1AA]">{autonomy}</span>
            </button>
          )}

          {streaming ? (
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              {value.trim() && (
                <button
                  type="button"
                  onClick={() => {
                    const content = value.trim();
                    setValue("");
                    stopAndSend(content);
                  }}
                  className="h-7 rounded-lg border border-[#26262B] bg-[#1B1B21] px-2 text-[11px] text-[#D4D4D8] hover:bg-[#26262B]"
                  title="Stop the current run and send this message now"
                >
                  Stop &amp; send
                </button>
              )}
              <button
                type="button"
                onClick={() => cancelStream()}
                className="w-7 h-7 rounded-lg bg-destructive/90 hover:bg-destructive flex items-center justify-center shadow-[0_4px_12px_rgba(239,68,68,0.3)]"
                aria-label="Stop"
              >
                <Square className="h-3 w-3 text-white fill-white" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim() || busy}
              className="ml-auto w-7 h-7 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#9B6AF1] flex items-center justify-center shadow-[0_4px_12px_rgba(124,58,237,0.3)] disabled:opacity-40 disabled:pointer-events-none shrink-0"
              aria-label="Send"
            >
              <Send className="h-3 w-3 text-white" />
            </button>
          )}
        </div>
      </div>
      <div className="text-[11px] text-[#52525B] mt-2 px-0.5 leading-snug">
        {validationError ? (
          <span className="text-destructive" role="alert">
            {validationError}
          </span>
        ) : isAsk ? (
          "Ask mode is read-only — no files change. Switch to Agent to make edits."
        ) : (
          "Zoc can make mistakes — checkpoints let you roll back."
        )}
      </div>
    </div>
  );
}
