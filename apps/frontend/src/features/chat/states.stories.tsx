/**
 * The panel's condition surfaces — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * The components that draw a *condition* rather than a message: the empty Session, the three banners,
 * and the three affordances that exist only while something is true. Each takes its condition as a
 * prop or reads it from the chat-local store, which is what makes 27.1's "default, loading, error, and
 * empty" a matter of listing variants here rather than of driving a Run.
 *
 * Two of them draw nothing in their ordinary case — `DegradedSecretsStrip` against a healthy keychain,
 * `JumpToLatest` while the transcript is anchored — and both say so on the story. A story showing only
 * the visible case leaves a reviewer unable to tell "renders nothing, deliberately" from "the story
 * forgot to pass the prop".
 *
 * `AttachmentTray` has no story and that is not an omission: it renders `<div class="contents">` with
 * `aria-hidden` and nothing inside, because M2 owns attachments and what the slot reserves today is
 * layout rather than an affordance (its own header says so). A story for it would be an empty box, and
 * task 33.1 is what gives it something to judge.
 */
import { useEffect, useState, type ReactNode } from "react";
import type { Story } from "@ladle/react";

import type { SecretStatus } from "@/lib/secure-store";
import { DegradedSecretsStrip } from "./DegradedSecretsStrip";
import { EmptyState } from "./EmptyState";
import type { RunPillState } from "./header/RunStatusPill";
import { JumpToLatest } from "./JumpToLatest";
import { ReadOnlyBanner } from "./ReadOnlyBanner";
import { RunAnnouncer } from "./RunAnnouncer";
import { RuntimeUnavailableBanner } from "./RuntimeUnavailableBanner";
import { useChatSurface } from "./store";
import { MODELS, WORKSPACE_ROOT } from "./story-fixtures";
import { StoryFrame, Variant } from "./story-frame";
import { StreamingCaret } from "./StreamingCaret";

export default { title: "Chat / States" };

const LOCAL = MODELS[0];
const CLOUD_WITHOUT_KEY = MODELS[2];

const DEGRADED: SecretStatus = {
  backend: "degraded",
  degraded: true,
  reason: "No OS keychain is reachable on this machine.",
};
const DEGRADED_UNEXPLAINED: SecretStatus = { backend: "degraded", degraded: true, reason: null };
const HEALTHY: SecretStatus = { backend: "keychain", degraded: false, reason: null };

const RUNTIME_REASON = "The runtime crashed during startup: port 7833 is already in use.";

/** A bounded column, because `EmptyState` centres itself in whatever height it is handed. */
function Box({ children }: { children: ReactNode }) {
  return <div className="flex h-64 flex-col">{children}</div>;
}

export const Empty: Story = () => (
  <StoryFrame brief="A Session with no turns. Judge whether the chips read as starting points rather than as the only four things the panel can do — and whether the blocked variant reads as one live action instead of three dead ones.">
    <Variant label="default" width={720}>
      <Box>
        <EmptyState
          workspaceRoot={WORKSPACE_ROOT}
          model={LOCAL}
          onPick={() => undefined}
          onAddKey={() => undefined}
        />
      </Box>
    </Variant>
    <Variant
      label="no workspace"
      note="`suggestionsFor(null)`: with no folder to name, the chips become questions about the editor."
      width={720}
    >
      <Box>
        <EmptyState workspaceRoot={null} model={LOCAL} onPick={() => undefined} />
      </Box>
    </Variant>
    <Variant
      label="cloud model, no key"
      note="R13.3. The suggestions are replaced rather than joined by a warning, because with no key every chip is a button that cannot work."
      width={720}
    >
      <Box>
        <EmptyState
          workspaceRoot={WORKSPACE_ROOT}
          model={CLOUD_WITHOUT_KEY}
          onPick={() => undefined}
          onAddKey={() => undefined}
        />
      </Box>
    </Variant>
    <Variant
      label="cloud model, no key, viewer"
      note="No `onAddKey`: a viewer cannot enter the host's key, so the sentence stands with no control under it."
      width={720}
    >
      <Box>
        <EmptyState
          workspaceRoot={WORKSPACE_ROOT}
          model={CLOUD_WITHOUT_KEY}
          onPick={() => undefined}
        />
      </Box>
    </Variant>
  </StoryFrame>
);

/**
 * The three banners, at the width they occupy in the panel and in the order the panel stacks them.
 *
 * All three sit *above* a transcript that keeps rendering — none of them is a reason to hide content
 * already on disk (R3.8) — so the judgement is whether each recedes enough to be read once and then
 * ignored, which is the opposite of what a modal would do.
 */
export const Banners: Story = () => (
  <StoryFrame brief="Who you are, how keys are stored, and whether the runtime is up. Judge the weight: each must be readable without competing with the transcript under it.">
    <Variant label="read-only — host named" width={720}>
      <ReadOnlyBanner host="mini.local" />
    </Variant>
    <Variant
      label="read-only — no host"
      note="The share URL carried no host label; the fact survives without it."
      width={720}
    >
      <ReadOnlyBanner />
    </Variant>
    <Variant label="runtime down — host" note="R3.8: the reason verbatim, and a retry." width={720}>
      <RuntimeUnavailableBanner reason={RUNTIME_REASON} onRestart={() => undefined} />
    </Variant>
    <Variant
      label="runtime down — restarting"
      note="The control cannot be pressed twice."
      width={720}
    >
      <RuntimeUnavailableBanner reason={RUNTIME_REASON} onRestart={() => undefined} restarting />
    </Variant>
    <Variant
      label="runtime down — viewer"
      note="No `onRestart`: a viewer cannot restart someone else's host, so the banner is the whole surface."
      width={720}
    >
      <RuntimeUnavailableBanner reason={RUNTIME_REASON} />
    </Variant>
    <Variant label="degraded secrets" note="R14.8, and not dismissible." width={720}>
      <DegradedSecretsStrip status={DEGRADED} />
    </Variant>
    <Variant
      label="degraded secrets — no reason given"
      note="The backend reported no reason; the consequence is still stated."
      width={720}
    >
      <DegradedSecretsStrip status={DEGRADED_UNEXPLAINED} />
    </Variant>
    <Variant
      label="healthy keychain"
      note="Renders nothing at all — the empty box below is the whole story. Keys are durable, so there is no fact to carry."
      width={720}
    >
      <DegradedSecretsStrip status={HEALTHY} />
    </Variant>
  </StoryFrame>
);

/**
 * Seeds the chat-local store, because `JumpToLatest` reads `anchored` and `rowsSinceUnanchored` from it
 * rather than from props — the transcript's scroll state is not the shell's to thread through.
 *
 * Written with `setState` rather than through the `setAnchored` action, which is the *user's* gesture and
 * clears the count as a side effect. The container is `relative` and has a height because the control
 * pins itself to the bottom of the scroll region it belongs to.
 */
function Unanchored({ rows, children }: { rows: number; children: ReactNode }) {
  useEffect(() => {
    useChatSurface.setState({ anchored: false, rowsSinceUnanchored: rows });
    return () => {
      useChatSurface.setState({ anchored: true, rowsSinceUnanchored: 0 });
    };
  }, [rows]);

  return (
    <div
      className="relative h-24 rounded-[var(--zoc-radius-card)]"
      style={{ backgroundColor: "var(--zoc-elev-1)" }}
    >
      {children}
    </div>
  );
}

/**
 * Reveals the announcer's live region and drives one transition into it after mount.
 *
 * Both halves are needed. The region is `sr-only`, so without the un-hiding a story of it is an empty
 * box; and it writes on a state *change* only — a first commit is deliberately silent, or a Session
 * restored mid-Run would announce a Run the user did not start — so a static `state` prop says nothing.
 * What is on screen here is the text a screen reader speaks, which is the only thing there is to judge.
 */
function Announced({ to, detail }: { to: RunPillState; detail?: string }) {
  const [state, setState] = useState<RunPillState>("idle");

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      setState(to);
    }, 200);
    return () => {
      globalThis.clearTimeout(timer);
    };
  }, [to]);

  return (
    <div
      className="font-mono [&_.sr-only]:not-sr-only"
      style={{ color: "var(--zoc-text-secondary)", fontSize: "var(--zoc-text-meta)" }}
    >
      <RunAnnouncer state={state} {...(detail === undefined ? {} : { failureDetail: detail })} />
    </div>
  );
}

export const Affordances: Story = () => (
  <StoryFrame brief="The three surfaces that appear only while something is true: a caret while text arrives, a jump control while the transcript is scrolled away, and an announcement on a lifecycle change.">
    <Variant
      label="streaming caret"
      note="Against a real line, because the caret is sized from the type scale to match whatever line the last character sits on. With OS reduced motion on, the blink stops and a dimmer steady bar takes over (R19.3, R21.7) — the substitution, not the absence."
      width={720}
    >
      <p style={{ color: "var(--zoc-text)", fontSize: "var(--zoc-text-body)" }}>
        Applying the guard to the transcript factory now
        <StreamingCaret />
      </p>
    </Variant>
    <Variant
      label="jump to latest"
      note="12 rows arrived while the reader was scrolled up; at zero the badge is absent rather than a `0`. One variant rather than two, because the count lives in a single store and a second mount would overwrite the first's. Press it: `setAnchored(true)` makes the control render nothing rather than hide, which is what keeps it out of the tab order (R21.1) — re-open the story to bring it back."
      width={720}
    >
      <Unanchored rows={12}>
        <JumpToLatest />
      </Unanchored>
    </Variant>
    <Variant
      label="run announcements"
      note="Un-hidden `sr-only` regions, each mounting idle and transitioning 200 ms later. `queued` and `awaiting-approval` are absent from the table on purpose: queuing is not a start, and the permission dock announces the approval itself (R21.3)."
      width={720}
    >
      <div className="flex flex-col gap-1">
        <Announced to="running" />
        <Announced to="completed" />
        <Announced to="cancelled" />
        <Announced to="interrupted" />
        <Announced to="failed" detail="rate limited by the provider" />
        <Announced to="queued" />
      </div>
    </Variant>
  </StoryFrame>
);
