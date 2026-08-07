/** Composer voice control — zoc-agent-chat-rebuild R31.1–R31.5. */
/** Feature: zoc-agent-chat-rebuild, task 35.1 (R31.1, R31.2, R31.3, R31.4, R31.5). */

import { useRef, useState } from "react";
import { Mic, Square } from "lucide-react";

import {
  voiceErrorMessage,
  type TranscriptionBackend,
  type TranscriptionSession,
} from "./voice-input";

export interface VoiceInputControlProps {
  readonly backend: TranscriptionBackend | null;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}

export function VoiceInputControl({
  backend,
  value,
  onChange,
  disabled = false,
}: VoiceInputControlProps) {
  const [recording, setRecording] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const session = useRef<TranscriptionSession | null>(null);
  const base = useRef("");

  if (backend === null) return null;

  const stop = () => {
    session.current?.stop();
    session.current = null;
    setRecording(false);
  };

  const start = async () => {
    if (disabled || recording) return;
    base.current = value;
    setReason(null);
    try {
      const opened = await backend.start({
        onTranscript: (text) => {
          const separator = base.current.length === 0 || /\s$/u.test(base.current) ? "" : " ";
          onChange(`${base.current}${separator}${text}`);
        },
        onError: (message) => {
          setReason(message);
          setRecording(false);
          session.current = null;
        },
        onEnd: () => {
          setRecording(false);
          session.current = null;
        },
      });
      session.current = opened;
      setRecording(true);
    } catch (error) {
      setReason(voiceErrorMessage(error));
      setRecording(false);
    }
  };

  return (
    <div className="contents" data-zoc-voice-input="">
      <button
        type="button"
        aria-label={recording ? "Stop voice input" : "Start voice input"}
        aria-pressed={recording}
        disabled={disabled}
        onClick={() => {
          if (recording) stop();
          else void start();
        }}
        className="inline-flex size-7 items-center justify-center rounded-[var(--zoc-radius-chip)] hover:bg-[var(--zoc-row-bg)] disabled:opacity-50"
        style={{ color: recording ? "var(--zoc-error)" : "var(--zoc-text-muted)" }}
        data-zoc-voice-recording={String(recording)}
      >
        {recording ? (
          <Square aria-hidden className="size-3 fill-current" />
        ) : (
          <Mic aria-hidden className="size-3.5" />
        )}
      </button>
      {recording ? (
        <span
          className="flex items-center gap-1 text-xs"
          role="status"
          data-zoc-recording-indicator=""
        >
          <span className="size-2 animate-pulse rounded-full bg-[var(--zoc-error)]" /> Recording
        </span>
      ) : null}
      {reason === null ? null : (
        <span
          className="basis-full text-xs text-[var(--zoc-error)]"
          role="alert"
          data-zoc-voice-error=""
        >
          {reason}
        </span>
      )}
    </div>
  );
}
