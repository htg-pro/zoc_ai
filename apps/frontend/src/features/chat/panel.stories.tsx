/**
 * The whole panel — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * The composition, at the four states 27.1 names, and the only story where the surface is judged as one
 * thing: the header's weight against the transcript's, the banners' stacking order, the composer's
 * height against the rows above it, and whether a Session with no turns reads as an invitation rather
 * than as a failure to load.
 *
 * ## Why the transport is a stub that never settles
 *
 * `ChatPanel` takes an injected transport, so the panel mounts with no runtime, no port to resolve, and
 * no key. A stream left open is what makes the in-flight state reachable: the reviewer types and sends,
 * and the Run stays running for as long as they look at it — the pill spins, the header grows a Stop, a
 * second submission becomes a queue count on the send control (R8.7). A transport that streamed canned
 * text would settle in a second and take that state away, and the *look* of arriving text already has a
 * story in `Chat / Transcript` (`TranscriptStreaming`).
 *
 * `secretStatus` is injected for the same reason: left out, the panel asks Desktop_Core, which is not
 * there in a browser, and the strip would flicker on whatever the failed probe resolved to.
 */
import type { Story } from "@ladle/react";
import type { ChatTransport, UIMessageChunk } from "ai";

import type { SecretStatus } from "@/lib/secure-store";
import { ChatPanel, type ChatPanelProps } from "./ChatPanel";
import { CANDIDATES, MESSAGES, MODELS, SESSIONS, WORKSPACE_ROOT } from "./story-fixtures";
import { StoryFrame } from "./story-frame";
import type { ZocUIMessage } from "./wire/ui-message";

export default { title: "Chat / Panel" };

/**
 * A transport that opens a Run and never settles it.
 *
 * The four methods the panel uses: `sendMessages` for a turn, `reconnectToStream` for a resume that has
 * nothing to resume, and `cancel`/`decideApproval`, which the panel reaches through a structural cast
 * rather than through `ChatTransport` — they are Zoc's two additions to it.
 */
class HeldTransport implements ChatTransport<ZocUIMessage> {
  sendMessages(): Promise<ReadableStream<UIMessageChunk>> {
    return Promise.resolve(new ReadableStream<UIMessageChunk>({ start: () => undefined }));
  }

  reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    return Promise.resolve(null);
  }

  cancel(): Promise<void> {
    return Promise.resolve();
  }

  decideApproval(): Promise<void> {
    return Promise.resolve();
  }
}

const HEALTHY: SecretStatus = { backend: "keychain", degraded: false, reason: null };
const DEGRADED: SecretStatus = {
  backend: "degraded",
  degraded: true,
  reason: "No OS keychain is reachable on this machine.",
};

const SESSION = SESSIONS[0];

/**
 * The props every variant shares, assembled as an object rather than spread into the element so the
 * overrides are checked against `ChatPanelProps` at the point they are written.
 */
function panelProps(overrides: Partial<ChatPanelProps> = {}): ChatPanelProps {
  return {
    sessionId: SESSION.id,
    sessionTitle: SESSION.title,
    sessions: SESSIONS,
    workspaceRoot: WORKSPACE_ROOT,
    initialMessages: MESSAGES,
    models: MODELS,
    selectedModel: MODELS[1],
    onSelectModel: () => undefined,
    onAddKey: () => undefined,
    permissionMode: "ask",
    onPermissionModeChange: () => undefined,
    candidates: CANDIDATES,
    onSelectSession: () => undefined,
    onNewSession: () => undefined,
    onCompact: () => undefined,
    onRestartRuntime: () => undefined,
    secretStatus: HEALTHY,
    transport: new HeldTransport(),
    ...overrides,
  };
}

/** A bounded viewport: the transcript virtualises against its container's height, not the page's. */
function Panel(overrides: Partial<ChatPanelProps> = {}) {
  return (
    <div className="flex h-[640px] flex-col">
      <ChatPanel {...panelProps(overrides)} />
    </div>
  );
}

/** A settled two-turn Session carrying every part the factory has an arm for. */
export const Default: Story = () => (
  <StoryFrame brief="The composed surface, settled. Judge the three horizontal bands — header, transcript, composer — and whether the transcript is what the eye lands on.">
    {Panel()}
  </StoryFrame>
);

/**
 * The in-flight state, which needs one gesture: type anything and send.
 *
 * Everything that changes is a consequence of the Run rather than a prop — the pill, the mark's spark,
 * the Stop control appearing in the header, the composer's queue count on a second send — so this is
 * the one state a story cannot pose.
 */
export const Running: Story = () => (
  <StoryFrame brief="Type a prompt and send it: the stub holds the Run open. Judge whether the panel reads as working rather than as stuck, and send again to see R8.7's queue count on the send control.">
    {Panel()}
  </StoryFrame>
);

/**
 * Two banners at once, which is the stacking the panel's own comment specifies: who you are, then how
 * keys are stored, then whether the runtime is up.
 */
export const RuntimeDown: Story = () => (
  <StoryFrame brief="The runtime is gone and keys are held in memory. Judge that the transcript below is still legible — neither banner is a reason to hide content already on disk (R3.8) — and that the two do not read as one paragraph.">
    {Panel({
      runtimeUnavailable: "The runtime crashed during startup: port 7833 is already in use.",
      secretStatus: DEGRADED,
    })}
  </StoryFrame>
);

/**
 * R1.4, and the story where absence is the thing being reviewed: no composer, no permission dock, no
 * Stop, no session mutation. The banner is the explanation for all of it.
 */
export const ReadOnlyViewer: Story = () => (
  <StoryFrame brief="A viewer watching a shared Session. Judge whether the surface reads as deliberately read-only rather than as a broken build with its controls missing.">
    {Panel({ readOnly: true, viewerHost: "mini.local" })}
  </StoryFrame>
);

/** No turns: the panel's onboarding surface, in place of a transcript. */
export const EmptySession: Story = () => (
  <StoryFrame brief="A new Session. Judge whether the empty state reads as an invitation, and whether it sits at a height that does not look like a loading failure.">
    {Panel({ initialMessages: [], sessionTitle: "New session" })}
  </StoryFrame>
);
