/**
 * The permission surface — zoc-agent-chat-rebuild task 27.1 (R17.5, R22.6).
 *
 * Feature: zoc-agent-chat-rebuild, task 27.1 (R17.5, R22.6).
 *
 * The one surface where a look failure is a consent failure. R11.4 gives the user three scopes, and the
 * difference between them is a sentence — `call` is this one write, `workspace` is every write for as long
 * as the workspace is open. If the three read as equally weighted, the dock has collected an approval the
 * user did not knowingly give, and no assertion about a label catches that.
 *
 * The countdown is driven by an injected `now` in every story here rather than the wall clock. Not for
 * determinism's sake — a story has no assertions — but because `PERMISSION`'s own `expiresAt` is in 2099
 * and a 73-year countdown renders as a bug. Each variant computes an expiry against `NOW_MS` instead, so
 * the three timing states (fresh, nearly out, expired) are all reachable on one screen.
 */
import { useState } from "react";
import type { Story } from "@ladle/react";

import type { PermissionRequestPart } from "@zoc-studio/shared-types";
import { StoryFrame, Variant } from "../story-frame";
import { PERMISSION } from "../story-fixtures";
import type { ZocUIMessage } from "../wire/ui-message";
import { PermissionDock } from "./PermissionDock";
import { PermissionRow } from "./PermissionRow";
import { PermissionWaitingRow } from "./PermissionWaitingRow";

export default { title: "Chat / Permission" };

const NOW_MS = Date.parse("2026-07-31T12:00:00.000Z");
const now = () => NOW_MS;

/** The fixture request with a countdown that has `secondsLeft` on it, and whatever else a variant needs. */
function request(
  secondsLeft: number,
  overrides: Partial<PermissionRequestPart> = {},
): PermissionRequestPart {
  return {
    ...PERMISSION,
    expiresAt: new Date(NOW_MS + secondsLeft * 1_000).toISOString(),
    ...overrides,
  };
}

/** The dock derives its pending request from `messages`, so a story feeds it a transcript, not a request. */
function messagesWith(pending: PermissionRequestPart): readonly ZocUIMessage[] {
  return [
    {
      id: "m-assistant",
      role: "assistant",
      parts: [{ type: "data-zoc-permission", data: pending }],
    },
  ];
}

/**
 * The row, across the three reasons a request exists and the three timing states.
 *
 * `destructive` is the variant to judge hardest: R11.6 asks for a request the user cannot approve by
 * reflex, and the only thing separating it from the ordinary write above it is its treatment.
 */
export const Rows: Story = () => (
  <StoryFrame brief="Approve is three decisions behind one control. Check that picking `workspace` feels like a bigger act than picking `call`.">
    <Variant
      label="mode-ask"
      note="R11.1's ordinary case: Ask mode asks before every write."
      width={720}
    >
      <PermissionRow
        request={request(420)}
        now={now}
        onApprove={() => undefined}
        onReject={() => undefined}
      />
    </Variant>
    <Variant
      label="out-of-plan-path"
      note="The tool reached outside the plan's files. The path is the whole point of the row."
      width={720}
    >
      <PermissionRow
        request={request(420, {
          requestId: "req-2",
          reason: "out-of-plan-path",
          prompt: "Write to a file the plan does not name?",
          paths: ["apps/frontend/src/lib/store.ts"],
        })}
        now={now}
        onApprove={() => undefined}
        onReject={() => undefined}
      />
    </Variant>
    <Variant label="destructive" note="R11.6: this one must resist a reflex approval." width={720}>
      <PermissionRow
        request={request(420, {
          requestId: "req-3",
          kind: "execute",
          toolName: "workspace_exec",
          reason: "destructive",
          prompt: "Run `rm -rf node_modules && pnpm install`?",
          paths: ["node_modules"],
          offeredScopes: ["call"],
        })}
        now={now}
        onApprove={() => undefined}
        onReject={() => undefined}
      />
    </Variant>
    <Variant
      label="nearly expired"
      note="Twelve seconds left. The countdown has to be noticeable without being the loudest thing."
      width={720}
    >
      <PermissionRow
        request={request(12, { requestId: "req-4" })}
        now={now}
        onApprove={() => undefined}
        onReject={() => undefined}
      />
    </Variant>
    <Variant
      label="one scope only"
      note="A request offering just `call`. The scope control must not imply choices the runtime will refuse."
      width={720}
    >
      <PermissionRow
        request={request(420, { requestId: "req-5", offeredScopes: ["call"] })}
        now={now}
        onApprove={() => undefined}
        onReject={() => undefined}
      />
    </Variant>
  </StoryFrame>
);

/**
 * The dock, which is the row plus what happens after the user presses.
 *
 * `onDecide` returns a promise, and the rejected variant is here because that rejection is a real state:
 * the runtime timed the request out while the user was reading it, and the dock has to say so rather than
 * silently closing. Press Approve in the second variant.
 */
export const Dock: Story = () => {
  const [failing, setFailing] = useState(true);
  return (
    <StoryFrame brief="Press Approve in the failing variant. A refused decision must leave the request on screen — closing it would look like consent landed.">
      <Variant label="pending" width={720}>
        <PermissionDock
          messages={messagesWith(request(420))}
          onDecide={() => Promise.resolve()}
          now={now}
        />
      </Variant>
      <Variant
        label="the decision is refused"
        note={`onDecide rejects${failing ? "" : " — now resolving"}. R11.9: the runtime may have already timed it out.`}
        width={720}
      >
        <PermissionDock
          messages={messagesWith(request(420, { requestId: "req-6" }))}
          onDecide={() => {
            setFailing(false);
            return failing
              ? Promise.reject(new Error("That request already timed out. The Run has moved on."))
              : Promise.resolve();
          }}
          now={now}
        />
      </Variant>
      <Variant
        label="nothing pending"
        note="An already-decided request: the dock draws nothing rather than an empty bar."
        width={720}
      >
        <PermissionDock
          messages={messagesWith(
            request(420, { requestId: "req-7", decision: "approve", decidedScope: "call" }),
          )}
          onDecide={() => Promise.resolve()}
          now={now}
        />
      </Variant>
      <Variant
        label="expired"
        note="Past its window: left to the runtime's timeout part, not rendered with dead controls."
        width={720}
      >
        <PermissionDock
          messages={messagesWith(request(-30, { requestId: "req-8" }))}
          onDecide={() => Promise.resolve()}
          now={now}
        />
      </Variant>
    </StoryFrame>
  );
};

/**
 * The transcript's placeholder for a request the dock is holding.
 *
 * It exists so the transcript does not have a hole where a tool call would be. It must read as *waiting*
 * and never as a second copy of the question — two places asking the same thing is two places to answer it.
 */
export const Waiting: Story = () => (
  <StoryFrame brief="This is the transcript's side of a pending request. It must not look answerable.">
    <Variant label="waiting" width={720}>
      <PermissionWaitingRow request={request(420)} />
    </Variant>
  </StoryFrame>
);
