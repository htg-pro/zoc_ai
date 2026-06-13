import {
  ArrowUpRight,
  BookOpen,
  CheckCircle2,
  FlaskConical,
  Settings2,
  Sparkles,
  Wrench,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/store";

const SUGGESTIONS = [
  {
    icon: Wrench,
    label: "Fix the failing build",
    prompt: "Fix the failing build: run diagnostics, identify errors, and apply the necessary fixes.",
  },
  {
    icon: Settings2,
    label: "Add a settings page",
    prompt: "Add a settings/preferences page with provider configuration and API key management.",
  },
  {
    icon: BookOpen,
    label: "Explain this repo",
    prompt:
      "Analyze this project: summarize the architecture, important files, issues, and recommended next steps.",
  },
];

/**
 * Polished empty state for the Agent Panel timeline.
 * Shows an animated orb, suggested actions, and quick command shortcuts.
 */
export function AgentEmptyState() {
  const send = useApp((s) => s.sendUserMessage);
  const runReview = useApp((s) => s.runReview);
  const runTests = useApp((s) => s.runTests);

  return (
    <div className="flex h-full flex-col items-center justify-center px-5 pb-6 pt-2">
      {/* Animated orb */}
      <div
        className="orb-breathe mb-4 flex h-14 w-14 shrink-0 items-center justify-center rounded-full"
        style={{
          background:
            "radial-gradient(circle at 32% 28%, #B794F6 0%, #8B5CF6 45%, #6D28D9 100%)",
        }}
        aria-hidden
      >
        <Sparkles className="h-[22px] w-[22px] text-white" />
      </div>

      <h3 className="text-center text-[15.5px] font-semibold tracking-tight text-foreground">
        What should we build?
      </h3>
      <p className="mt-1.5 max-w-[268px] text-center text-[12px] leading-[1.55] text-muted-foreground">
        Pick a session or start a new run. The agent plans, builds, validates and
        hands you a clean diff.
      </p>

      {/* Suggestion prompt buttons */}
      <div className="mt-4 w-full max-w-[288px] space-y-1.5">
        {SUGGESTIONS.map(({ icon: Icon, label, prompt }) => (
          <button
            key={label}
            type="button"
            onClick={() => void send(prompt)}
            className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-card/60 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-[12px] text-foreground">{label}</span>
            <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
          </button>
        ))}
      </div>

      {/* Quick action row */}
      <div className="mt-4 flex flex-wrap justify-center gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void runReview()}
        >
          <CheckCircle2 className="h-3 w-3" />
          Review
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() => void runTests()}
        >
          <FlaskConical className="h-3 w-3" />
          Test
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 text-xs"
          onClick={() =>
            void send(
              "Analyze this project: summarize the architecture, important files, issues, and next steps.",
            )
          }
        >
          <Sparkles className="h-3 w-3" />
          Analyze
        </Button>
      </div>
    </div>
  );
}
