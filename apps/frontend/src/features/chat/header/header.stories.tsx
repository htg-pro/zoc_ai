/**
 * The header — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * The header is the panel's status line, and its two hard requirements are look-only. R13.9 asks whether a
 * Run's state is legible at a glance across eight states, which no assertion about a label can answer;
 * `PillStates` puts all eight in one column so a reviewer can find `failed` without reading. And R13.3's
 * key-entry affordance is judged by whether a keyless model looks *unavailable rather than broken* —
 * `Picker` shows the keyed and keyless rows together, which is the only way that comparison exists.
 *
 * `ChatHeader` takes `brand` and `contextMeter` as elements rather than rendering them, so `Header` below
 * passes the same `ZocMark` and `ContextMeter` the panel does. A story that passed neither would be
 * checking a layout the app never ships.
 */
import { useState } from "react";
import type { Story } from "@ladle/react";

import { StoryFrame, Variant } from "../story-frame";
import { CENSUS, MODEL, MODELS, SESSIONS, WORKSPACE_ROOT, NOW } from "../story-fixtures";
import { ZocMark } from "../brand/ZocMark";
import { ContextMeter } from "../composer/ContextMeter";
import type { PermissionMode } from "../composer/mode-consequence";
import { ChatHeader } from "./ChatHeader";
import { ChatMenu } from "./ChatMenu";
import { ModelPicker } from "./ModelPicker";
import { PermissionModeToggle } from "./PermissionModeToggle";
import { RunStatusPill, type RunPillState } from "./RunStatusPill";
import { SessionSwitcher } from "./SessionSwitcher";
import type { ModelChoice } from "./model-catalogue";

export default { title: "Chat / Header" };

const PILL_STATES: readonly RunPillState[] = [
  "idle",
  "queued",
  "running",
  "awaiting-approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
];

/** The switcher's own props, minus the callbacks, since every story wires the same list. */
const SESSION_LIST = {
  sessions: SESSIONS,
  activeSessionId: "s-1",
  workspaceRoot: WORKSPACE_ROOT,
  onSelect: () => undefined,
  now: NOW,
} as const;

/**
 * The assembled header, at the two widths its container query decides between.
 *
 * The narrow variant is the one to check: R22.6 moves the model picker and the context figure into the
 * overflow menu below a threshold, and the failure mode is a header that keeps both and clips the title.
 */
export const Header: Story = () => {
  const [model, setModel] = useState<ModelChoice | null>(MODELS[1] ?? null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("ask");
  return (
    <StoryFrame brief="Wide and narrow. Nothing may clip: below the breakpoint the picker and the meter belong in the overflow menu, not squeezed.">
      <Variant label="wide" width={860}>
        <ChatHeader
          brand={<ZocMark size={24} state="idle" />}
          contextMeter={
            <ContextMeter
              model={MODEL}
              census={CENSUS}
              mentions={[]}
              onRemoveMentions={() => undefined}
            />
          }
          sessionTitle="Guard the empty row list in the transcript factory"
          sessionList={SESSION_LIST}
          onNewSession={() => undefined}
          models={MODELS}
          selectedModel={model}
          onSelectModel={setModel}
          onAddKey={() => undefined}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          runState="idle"
          runElapsedMs={0}
          onCompact={() => undefined}
          onRestartRuntime={() => undefined}
        />
      </Variant>
      <Variant
        label="narrow"
        note="R22.6's container query: the picker and the figure move into the menu."
        width={420}
      >
        <ChatHeader
          brand={<ZocMark size={24} state="running" />}
          contextMeter={
            <ContextMeter
              model={MODEL}
              census={CENSUS}
              mentions={[]}
              onRemoveMentions={() => undefined}
            />
          }
          sessionTitle="Guard the empty row list in the transcript factory"
          sessionList={SESSION_LIST}
          models={MODELS}
          selectedModel={model}
          onSelectModel={setModel}
          permissionMode={permissionMode}
          onPermissionModeChange={setPermissionMode}
          runState="running"
          runElapsedMs={12_400}
          tokensPerSecond={41}
          onCancelRun={() => undefined}
        />
      </Variant>
    </StoryFrame>
  );
};

/**
 * All eight `RunPillState` values, plus the two figures the running pill carries.
 *
 * `cancelled` and `interrupted` are the pair most likely to have collapsed into one look, and they mean
 * different things — the user stopped it, versus the process died under it.
 */
export const PillStates: Story = () => (
  <StoryFrame brief="Eight states. Greyscale this too: `failed` and `cancelled` must not depend on red-versus-grey alone.">
    <Variant label="every state">
      <div className="flex flex-col items-start gap-2">
        {PILL_STATES.map((state) => (
          <RunStatusPill
            key={state}
            state={state}
            elapsedMs={state === "idle" ? 0 : 12_400}
            onCancel={() => undefined}
          />
        ))}
      </div>
    </Variant>
    <Variant label="running — with a rate" note="R13.9's tok/s, shown only while a Run streams.">
      <RunStatusPill
        state="running"
        elapsedMs={38_900}
        tokensPerSecond={41}
        onCancel={() => undefined}
      />
    </Variant>
    <Variant
      label="running — no rate yet"
      note="Before the first measurement. The pill must not read 0 tok/s."
    >
      <RunStatusPill
        state="running"
        elapsedMs={900}
        tokensPerSecond={null}
        onCancel={() => undefined}
      />
    </Variant>
  </StoryFrame>
);

/**
 * The model picker, open, with all three key states in the list.
 *
 * A local model, a cloud model with a key, and a cloud model without one. The third must be selectable —
 * R13.3 blocks the *Run*, not the choice — and must offer key entry rather than just refusing.
 */
export const Picker: Story = () => {
  const [selected, setSelected] = useState<ModelChoice | null>(MODELS[1] ?? null);
  return (
    <StoryFrame brief="Open the picker. The keyless model should read as unavailable-until-configured, not as broken.">
      <Variant label="a model selected" width={380}>
        <ModelPicker
          models={MODELS}
          selected={selected}
          onSelect={setSelected}
          onAddKey={() => undefined}
        />
      </Variant>
      <Variant
        label="nothing selected"
        note="Before a Session has a model — the trigger has to say so."
        width={380}
      >
        <ModelPicker
          models={MODELS}
          selected={null}
          onSelect={() => undefined}
          onAddKey={() => undefined}
        />
      </Variant>
      <Variant
        label="no key entry offered"
        note="Without `onAddKey` the row still cannot run and now says nothing about the fix — the shape to avoid."
        width={380}
      >
        <ModelPicker models={MODELS} selected={selected} onSelect={() => undefined} />
      </Variant>
    </StoryFrame>
  );
};

/** The permission axis and the overflow menu — small controls whose states are all in their triggers. */
export const Controls: Story = () => {
  const [mode, setMode] = useState<PermissionMode>("ask");
  return (
    <StoryFrame brief="R11.1's second axis. `deny` is a promise about the whole Session and should carry more weight than a toggle usually does.">
      <Variant label="permission mode" note={`Selected: ${mode}.`}>
        <PermissionModeToggle value={mode} onChange={setMode} />
      </Variant>
      <Variant label="menu" note="R34.4's Compact and R3.8's runtime restart.">
        <ChatMenu onCompact={() => undefined} onRestartRuntime={() => undefined} />
      </Variant>
      <Variant
        label="menu — nothing offered"
        note="No host callbacks: the menu is empty rather than full of dead items."
      >
        <ChatMenu />
      </Variant>
    </StoryFrame>
  );
};

/**
 * The session switcher, which is `SessionList` behind a trigger.
 *
 * `SESSIONS` holds a Session in another workspace on purpose: R15.10 says the switcher must not list it.
 * Open the popover and count — four rows, not five.
 */
export const Switcher: Story = () => (
  <StoryFrame brief="Open it. The fifth fixture Session lives in another workspace and must not appear (R15.10).">
    <Variant label="five sessions, one out of scope" width={420}>
      <SessionSwitcher
        {...SESSION_LIST}
        title="Guard the empty row list in the transcript factory"
        onNewSession={() => undefined}
        onTogglePin={() => undefined}
        onRename={() => undefined}
        onFork={() => undefined}
        onArchive={() => undefined}
        pinned={{ "s-2": true }}
      />
    </Variant>
    <Variant
      label="no sessions"
      note="A fresh workspace: the trigger still names the current draft Session."
      width={420}
    >
      <SessionSwitcher
        sessions={[]}
        activeSessionId={null}
        workspaceRoot={WORKSPACE_ROOT}
        onSelect={() => undefined}
        now={NOW}
        title="Untitled"
        onNewSession={() => undefined}
      />
    </Variant>
  </StoryFrame>
);
