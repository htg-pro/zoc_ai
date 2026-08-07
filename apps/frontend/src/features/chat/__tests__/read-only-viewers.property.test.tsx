/**
 * Property 58: Read-only viewers get no mutating controls — zoc-agent-chat-rebuild R1.4, task 22.9.
 *
 * *For any* transcript state — including one with a pending approval request and an active Run —
 * rendering under a read-only viewer context produces a tree containing no run-start, decision, or
 * cancel control.
 *
 * ## Why every case renders twice
 *
 * An absence assertion passes for two reasons: the control is absent because the panel omitted it, or the
 * selector never matched anything in the first place. The second is the failure mode that makes a
 * read-only test worthless, and no amount of care in writing the selectors rules it out — the attribute
 * gets renamed six months later and the property goes quietly vacuous.
 *
 * So each generated state is rendered twice, once as a host and once as a viewer, and the host render is
 * asserted to *produce* the very controls the viewer render is asserted to lack. A stale selector now
 * fails the host half. That pairing is the load-bearing part of this file.
 *
 * ## Absent, not disabled
 *
 * Task 22.8 is explicit that read-only omits rather than disables, so `[disabled]` anywhere in the
 * viewer's subtree is itself a failure. This is not a stylistic preference: a disabled control is still
 * announced to a screen reader, still focusable in some browsers, and still reads as "this will work
 * once I fix something". Nothing a viewer can fix will make it work.
 *
 * The check earns its place against a specific control. `PlanRow`'s apply renders `disabled` with a
 * reason — "two hunks are stale" is the answer a host needs to why the button will not go — and that
 * same control in a viewer's tree was the defect this property found. The three decision classes below
 * are also why read-only had to travel *with* the review surface rather than being expressed by
 * withholding its handlers: a hunk decision writes to the chat-local store, so accept and reject would
 * have gone on rendering and gone on toggling with every handler stripped.
 *
 * ## What is deliberately not asserted
 *
 * The empty state's three suggestion chips. They write the composer draft, which is a *draft* control
 * rather than one of the property's three classes, and a viewer's draft goes nowhere because there is no
 * composer to hold it. Worth revisiting; out of scope for the sentence being asserted here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import fc from "fast-check";
import type { ChatTransport, UIMessageChunk } from "ai";
import type {
  DiffPart,
  Hunk,
  PermissionRequestPart,
  PlanPart,
  RunLifecyclePart,
} from "@zoc-studio/shared-types";

import { ChatPanel, type ChatPanelProps } from "@/features/chat/ChatPanel";
import type { ModelChoice } from "@/features/chat/header/model-catalogue";
import type { SecretStatus } from "@/lib/secure-store";
import type { ZocUIMessage } from "@/features/chat/wire/ui-message";
import { installFakeLayout, resetChatSurface } from "./transcript-harness";

// ── A transport that opens nothing ────────────────────────────────────
//
// This property never sends. The Run states it needs are the ones a *restored* Session carries, which is
// also the only way a viewer can have an active Run to look at: a viewer has no composer to start one.

class InertTransport implements ChatTransport<ZocUIMessage> {
  sendMessages(): Promise<ReadableStream<UIMessageChunk>> {
    return Promise.resolve(new ReadableStream<UIMessageChunk>({ start: () => {} }));
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

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = Date.parse("2026-07-31T10:00:00.000Z");
const PLAN_ID = "plan_1";

const MODEL: ModelChoice = {
  provider: "anthropic",
  providerLabel: "Anthropic",
  modelId: "claude-opus-5",
  label: "Opus 5",
  requiresKey: true,
  hasKey: true,
  local: false,
  contextLimit: 200_000,
};

const HEALTHY_SECRETS: SecretStatus = { backend: "keychain", degraded: false, reason: null };

const base = (seq: number, messageId: string) => ({
  seq,
  runId: "run_1",
  messageId,
  ts: new Date(NOW).toISOString(),
  agentName: null,
});

/**
 * Pending: undecided and not yet expired, which is what the dock renders a decision for.
 *
 * The deadline is relative to the wall clock rather than to this file's fixed `NOW`, because `ChatPanel`
 * does not inject the dock's `now` — it defaults to `Date.now`. A fixed future date would silently pass
 * into the past and take the dock's controls with it, which is a test that stops testing.
 */
function permissionPart(): PermissionRequestPart {
  return {
    ...base(12, "approval-1"),
    type: "permission-request",
    requestId: "req_1",
    toolCallId: "call_1",
    toolName: "workspace_run_command",
    kind: "execute",
    prompt: "Allow workspace_run_command?",
    paths: ["src/a.ts"],
    reason: "destructive",
    offeredScopes: ["call", "run", "workspace"],
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    decision: null,
    decidedScope: null,
  };
}

/**
 * A Run that is still going, in a transcript nobody is streaming.
 *
 * `runSnapshotOf` reads the newest lifecycle part and, with the hook idle and no terminal state, reports
 * `running` — so a restored Session with a `running` part is an active Run, which is exactly the state a
 * viewer attached mid-Run sees.
 */
function runningPart(): RunLifecyclePart {
  return {
    ...base(3, "run-1"),
    type: "run-lifecycle",
    state: "running",
    code: null,
    message: null,
  };
}

function hunk(id: string): Hunk {
  return {
    hunkId: id,
    oldStart: 10,
    oldLines: 2,
    newStart: 10,
    newLines: 3,
    patch: "-const before = 1;\n+const after = 1;\n+const extra = 2;\n",
  };
}

function diffPart(path: string): DiffPart {
  return {
    ...base(4, "plan-1"),
    type: "diff",
    planId: PLAN_ID,
    path,
    action: "modify",
    sourcePath: null,
    language: "typescript",
    hunks: [hunk("h1"), hunk("h2")],
    baseDigest: "sha256:base",
    stale: false,
  };
}

function planPart(diffs: readonly DiffPart[]): PlanPart {
  return {
    ...base(5, "plan-1"),
    type: "plan",
    planId: PLAN_ID,
    title: "Refactor the auth module",
    files: diffs.map((diff) => ({
      path: diff.path,
      action: diff.action,
      sourcePath: null,
      rationale: "why",
      addedLines: 4,
      removedLines: 2,
      hunkCount: diff.hunks.length,
    })),
    verificationCommand: "pnpm test --run",
  };
}

// ── The transcript state, and the controls each ingredient earns ──────

/**
 * The generated domain.
 *
 * The property's own sentence names two of these — "including one with a pending approval request and an
 * active Run" — so they are dimensions of the input rather than two extra hand-written cases. `plan` and
 * `bareDiff` are here because they reach the two decision controls that are *not* handler-gated: apply
 * renders disabled-with-a-reason, and a hunk decision writes to the store.
 */
interface Shape {
  readonly turns: number;
  readonly pendingApproval: boolean;
  readonly activeRun: boolean;
  readonly plan: boolean;
  readonly bareDiff: boolean;
}

const shape: fc.Arbitrary<Shape> = fc.record({
  // Small on purpose: above 60 rows the transcript virtualises, and "absent" would then be ambiguous
  // between omitted and merely unmounted.
  turns: fc.integer({ min: 0, max: 3 }),
  pendingApproval: fc.boolean(),
  activeRun: fc.boolean(),
  plan: fc.boolean(),
  bareDiff: fc.boolean(),
});

function transcriptOf(input: Shape): ZocUIMessage[] {
  const messages: ZocUIMessage[] = [];

  for (let index = 0; index < input.turns; index += 1) {
    messages.push({
      id: `u${String(index)}`,
      role: "user",
      parts: [{ type: "text", text: `prompt ${String(index)}` }],
    });
    messages.push({
      id: `a${String(index)}`,
      role: "assistant",
      parts: [{ type: "text", text: `answer ${String(index)}`, state: "done" }],
    });
  }

  if (input.plan) {
    const diffs = [diffPart("src/a.ts")];
    messages.push({
      id: "plan-1",
      role: "assistant",
      parts: [
        { type: "data-zoc-plan", data: planPart(diffs) },
        ...diffs.map((diff) => ({ type: "data-zoc-diff" as const, data: diff })),
      ],
    });
  }

  if (input.bareDiff) {
    // A different `planId`, so the plan row above cannot absorb it and it renders as its own diff row —
    // the arm that reaches `HunkRow`'s accept and reject without a file having to be expanded first.
    messages.push({
      id: "diff-1",
      role: "assistant",
      parts: [{ type: "data-zoc-diff", data: { ...diffPart("src/b.ts"), planId: "plan_2" } }],
    });
  }

  if (input.pendingApproval) {
    messages.push({
      id: "approval-1",
      role: "assistant",
      parts: [
        { type: "text", text: "I need to run the tests.", state: "done" },
        { type: "data-zoc-permission", data: permissionPart() },
      ],
    });
  }

  if (input.activeRun) {
    messages.push({
      id: "run-1",
      role: "assistant",
      parts: [{ type: "data-zoc-run", data: runningPart() }],
    });
  }

  return messages;
}

/** The three classes the property names, as the selectors that find them. */
const RUN_START = ["[data-zoc-composer]", "[data-zoc-send]"] as const;
const CANCEL = ["[data-zoc-run-cancel]"] as const;
const APPROVAL_DECISION = [
  "[data-zoc-permission-dock]",
  "[data-zoc-permission-approve]",
  "[data-zoc-permission-reject]",
] as const;
const PLAN_DECISION = ["[data-zoc-plan-apply]", "[data-zoc-plan-discard]"] as const;
const HUNK_DECISION = ["[data-zoc-hunk-accept]", "[data-zoc-hunk-reject]"] as const;

/** Which classes a host is owed for this state — the other half of every absence below. */
function expectedForHost(input: Shape): readonly (readonly string[])[] {
  const classes: (readonly string[])[] = [[...RUN_START]];
  if (input.activeRun) classes.push([...CANCEL]);
  if (input.pendingApproval) classes.push([...APPROVAL_DECISION]);
  if (input.plan) classes.push([...PLAN_DECISION]);
  if (input.bareDiff) classes.push([...HUNK_DECISION]);
  return classes;
}

const ALL_MUTATING = [
  ...RUN_START,
  ...CANCEL,
  ...APPROVAL_DECISION,
  ...PLAN_DECISION,
  ...HUNK_DECISION,
] as const;

function renderPanel(input: Shape, readOnly: boolean): void {
  const props: ChatPanelProps = {
    sessionId: "session-1",
    sessionTitle: "A session",
    sessions: [],
    workspaceRoot: "/home/dev/archivezip",
    initialMessages: transcriptOf(input),
    models: [MODEL],
    selectedModel: MODEL,
    onSelectModel: vi.fn(),
    permissionMode: "ask",
    onPermissionModeChange: vi.fn(),
    onSelectSession: vi.fn(),
    secretStatus: HEALTHY_SECRETS,
    transport: new InertTransport(),
    // Every mutation the host offers, so read-only has something to withhold. A viewer's absences are
    // only meaningful against a host that was given the whole surface.
    onNewSession: vi.fn(),
    onRenameSession: vi.fn(),
    onForkSession: vi.fn(),
    onDuplicateSession: vi.fn(),
    onArchiveSession: vi.fn(),
    onDeleteSession: vi.fn(),
    onCompact: vi.fn(),
    onRestartRuntime: vi.fn(),
    onAddKey: vi.fn(),
    review: { onApply: vi.fn(), onDiscard: vi.fn(), onRegenerate: vi.fn(), onRollback: vi.fn() },
    readOnly,
    ...(readOnly ? { viewerHost: "192.168.1.14:52311" } : {}),
  };
  render(<ChatPanel {...props} />);
}

const found = (selector: string): number => document.querySelectorAll(selector).length;

/**
 * jsdom gives every element a zero height, and the transcript virtualises against measured heights — so
 * without the harness's self-consistent fake layout the container mounts and no row inside it does.
 * Every "the control is absent" assertion would then be true because nothing rendered.
 */
let uninstallLayout: () => void;

beforeEach(() => {
  uninstallLayout = installFakeLayout();
});

afterEach(() => {
  cleanup();
  uninstallLayout();
  vi.restoreAllMocks();
});

describe("Feature: zoc-agent-chat-rebuild, task 22.9 — Property 58: read-only viewers (R1.4)", () => {
  it("omits every run-start, decision, and cancel control the same state gives a host", () => {
    fc.assert(
      fc.property(shape, (input) => {
        const state = JSON.stringify(input);

        // The host half. Asserted first and asserted positively, so a selector that has drifted fails
        // here instead of making every absence below true for the wrong reason.
        resetChatSurface();
        renderPanel(input, false);
        for (const group of expectedForHost(input)) {
          for (const selector of group) {
            expect(found(selector), `a host is owed ${selector} for ${state}`).toBeGreaterThan(0);
          }
        }
        cleanup();

        // The viewer half.
        resetChatSurface();
        renderPanel(input, true);
        for (const selector of ALL_MUTATING) {
          expect(found(selector), `a viewer must not get ${selector} for ${state}`).toBe(0);
        }

        // And the absences are absences *within a rendered panel* — R1.4 withholds controls, it does not
        // withhold the conversation. Without this the property would pass against a panel that rendered
        // nothing at all for a viewer.
        expect(found("[data-zoc-chat-panel]"), `a viewer still gets the panel for ${state}`).toBe(
          1,
        );
        expect(
          found("[data-zoc-read-only-banner]"),
          `the banner explains the absences for ${state}`,
        ).toBe(1);
        if (transcriptOf(input).length > 0) {
          expect(
            found("[data-zoc-transcript-scroll]"),
            `a viewer still reads the transcript for ${state}`,
          ).toBeGreaterThan(0);
        }
        cleanup();
      }),
      { numRuns: 48 },
    );
  });

  it("leaves nothing merely disabled in the viewer's tree", () => {
    // Task 22.8's rule, and the one this property caught: `PlanRow`'s apply renders `disabled` with a
    // reason, which is informative for a host and an invitation to nothing for a viewer.
    fc.assert(
      fc.property(shape, (input) => {
        resetChatSurface();
        renderPanel(input, true);
        expect(document.querySelectorAll("[data-zoc-chat-panel] [disabled]")).toHaveLength(0);
        expect(
          document.querySelectorAll("[data-zoc-chat-panel] [aria-disabled='true']"),
        ).toHaveLength(0);
        cleanup();
      }),
      { numRuns: 32 },
    );
  });

  it("keeps the plan readable while making it undecidable", () => {
    // The narrow claim behind the review-surface change: a viewer came to see what was proposed, so the
    // card, its files, and its counts stay — only the decisions go.
    const input: Shape = {
      turns: 1,
      pendingApproval: false,
      activeRun: false,
      plan: true,
      bareDiff: true,
    };
    resetChatSurface();
    renderPanel(input, true);

    expect(found("[data-zoc-plan-card]")).toBe(1);
    expect(found("[data-zoc-plan-file]")).toBeGreaterThan(0);
    expect(found("[data-zoc-hunk-row]")).toBeGreaterThan(0);
    expect(found("[data-zoc-plan-apply]")).toBe(0);
    expect(found("[data-zoc-hunk-accept]")).toBe(0);
  });
});
