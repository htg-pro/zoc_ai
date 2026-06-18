import type { Story } from "@ladle/react";
import { useEffect } from "react";
import { AgentRunFeedView } from "./AgentRunFeed";
import { ToolCallCard } from "./ToolCallCard";
import { DiffCard } from "./DiffCard";
import { MessageItem } from "./MessageItem";
import { MOCK_DIFF, MOCK_MESSAGES, MOCK_PLAN, MOCK_TOOL_CALL } from "@/lib/mock-data";
import type { ToolCall } from "@zoc-studio/shared-types";
import { useApp } from "@/lib/store";

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
      <AgentRunFeedView events={[]} />
    </div>
  );
};
