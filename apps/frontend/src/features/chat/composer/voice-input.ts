/** Transcription backend abstraction and browser implementation — zoc-agent-chat-rebuild R31. */
/** Feature: zoc-agent-chat-rebuild, task 35.1 (R31.1, R31.2, R31.3, R31.4, R31.5). */

export interface TranscriptionSession {
  stop(): void;
}

export interface TranscriptionBackend {
  readonly label: string;
  start(callbacks: {
    readonly onTranscript: (text: string) => void;
    readonly onError: (reason: string) => void;
    readonly onEnd: () => void;
  }): Promise<TranscriptionSession>;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: { readonly transcript: string };
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { readonly error?: string; readonly message?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function recognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const candidate = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return candidate.SpeechRecognition ?? candidate.webkitSpeechRecognition ?? null;
}

export function voiceErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "error" in error
      ? String((error as { error?: unknown }).error ?? "")
      : "";
  if (code === "not-allowed" || code === "service-not-allowed") {
    return "Microphone permission was refused. You can keep typing instead.";
  }
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Microphone permission was refused. You can keep typing instead.";
  }
  if (error instanceof Error && error.message.length > 0) return error.message;
  return "Voice transcription could not start. You can keep typing instead.";
}

/** Returns null when this renderer has no configured browser transcription facility. */
export function createBrowserTranscriptionBackend(): TranscriptionBackend | null {
  const Recognition = recognitionConstructor();
  if (Recognition === null) return null;
  return {
    label: "Browser speech recognition",
    start: async (callbacks) => {
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = typeof navigator === "undefined" ? "en-US" : navigator.language || "en-US";
      let finalText = "";
      recognition.onresult = (event) => {
        let interim = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          const transcript = result?.[0]?.transcript ?? "";
          if (result?.isFinal) finalText += transcript;
          else interim += transcript;
        }
        callbacks.onTranscript(`${finalText}${interim}`.trimStart());
      };
      recognition.onerror = (event) => callbacks.onError(voiceErrorMessage(event));
      recognition.onend = callbacks.onEnd;
      try {
        recognition.start();
      } catch (error) {
        throw new Error(voiceErrorMessage(error));
      }
      return { stop: () => recognition.stop() };
    },
  };
}
