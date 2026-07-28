import type { Story } from "@ladle/react";
import { useEffect } from "react";
import { RunCardView } from "./RunCardView";
import { normalizeEvents } from "./normalize";
import { ToolCallCard } from "./ToolCallCard";
import { DiffCard } from "./DiffCard";
import { MessageItem } from "./MessageItem";
import { MOCK_DIFF, MOCK_MESSAGES, MOCK_PLAN, MOCK_TOOL_CALL } from "@/lib/mock-data";
import type { ToolCall } from "@zoc-studio/shared-types";
import { useApp } from "@/lib/store";

/**
 * A small run card for the demo surfaces. Built through the real
 * `normalizeEvents` fold so the story cannot drift from what the app renders.
 */
const DEMO_CARD = {
  runId: "demo-run",
  rows: normalizeEvents(
    [
      {
        type: "intent",
        seq: 0,
        runId: "demo-run",
        ts: "2024-01-01T00:00:00.000Z",
        text: "Add a settings toggle",
        modelTier: "local-slm",
        contextWindowTokens: 4096,
      },
      {
        type: "command",
        seq: 1,
        runId: "demo-run",
        ts: "2024-01-01T00:00:01.000Z",
        command: "pnpm test",
        exitCode: 0,
      },
    ],
    { activeRunId: "demo-run", boundMessageId: null, highestSeq: -1 },
  ).rows,
};

export default { title: "Agent" };

const baseTool: ToolCall = MOCK_TOOL_CALL;
const variants: ToolCall[] = [
  { ...baseTool, id: "t-1", status: "pending" },
  { ...baseTool, id: "t-2", status: "running" },
  { ...baseTool, id: "t-3", status: "needs_approval" },
  { ...baseTool, id: "t-4", status: "succeeded" },
  { ...baseTool, id: "t-5", status: "failed", error: "EACCES: permission denied" },
];

export const Messages: Story = () => (
  <div className="flex max-w-2xl flex-col gap-2">
    {MOCK_MESSAGES.map((m) => (
      <MessageItem key={m.id} message={m} />
    ))}
  </div>
);

export const ToolCallStates: Story = () => (
  <div className="flex max-w-xl flex-col gap-2">
    {variants.map((t) => (
      <ToolCallCard key={t.id} call={t} />
    ))}
  </div>
);

export const DiffCardStory: Story = () => (
  <div className="max-w-xl">
    <DiffCard patch={MOCK_DIFF} />
  </div>
);

export const Plan: Story = () => {
  useEffect(() => {
    useApp.setState({
      agentItems: [
        {
          type: "plan",
          id: `plan-${MOCK_PLAN.id}`,
          plan: MOCK_PLAN,
          status: "pending",
          createdAt: MOCK_PLAN.created_at,
        },
      ],
    });
  }, []);
  return (
    <div className="max-w-xl">
      <RunCardView card={DEMO_CARD} focused collapsed={false} />
    </div>
  );
};
