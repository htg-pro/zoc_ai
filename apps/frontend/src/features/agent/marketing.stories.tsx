import type { Story } from "@ladle/react";
import { useEffect, type ReactNode } from "react";
import { Paperclip, Send, Sparkles } from "lucide-react";
import type { Message, ToolCall, ToolDescriptor } from "@zoc-studio/shared-types";
import { AgentRunFeedView } from "./AgentRunFeed";
import { MessageItem } from "./MessageItem";
import { ToolCallCard } from "./ToolCallCard";
import { MOCK_PLAN } from "@/lib/mock-data";
import { useApp, type AgentWorkflowItem } from "@/lib/store";

export default { title: "Marketing" };

const nowIso = (offset = 0) => new Date(Date.now() - offset).toISOString();

const CHAT_MESSAGES: Message[] = [
  {
    id: "m1",
    role: "user",
    content: "Add a settings screen with provider configuration and API key management.",
    created_at: nowIso(120_000),
  },
  {
    id: "m2",
    role: "assistant",
    content:
      "On it. I'll add a sectioned settings view, wire up the providers form, and keep secrets in the OS secure store so keys never touch disk in plaintext. Drafting a plan now…",
    created_at: nowIso(115_000),
  },
  {
    id: "m3",
    role: "assistant",
    content:
      "Drafted a 5-step plan. Step 1 is done — I scanned the existing module and found no prior settings screen, so I'm creating one under src/features/settings.",
    created_at: nowIso(60_000),
  },
];

const WRITE_CALL: ToolCall = {
  id: "tc-write",
  name: "fs.write",
  arguments: { path: "/src/features/settings/SettingsView.tsx", bytes: 4823 },
  status: "succeeded",
  result: { written: 4823, sha: "9f1b…" },
  started_at: nowIso(8_000),
  finished_at: nowIso(2_000),
};

const APPROVAL_CALL: ToolCall = {
  id: "tc-approve",
  name: "shell.run",
  arguments: { command: "pnpm test src/features/settings", cwd: "/workspace" },
  status: "needs_approval",
  result: null,
  started_at: nowIso(1_000),
  finished_at: null,
};

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  {
    name: "shell.run",
    description: "Execute a command in the workspace shell.",
    json_schema: {},
    destructive: true,
    requires_approval: true,
    requires_scopes: ["run_command"],
  },
  {
    name: "fs.write",
    description: "Create or overwrite a file in the workspace.",
    json_schema: {},
    destructive: true,
    requires_approval: true,
    requires_scopes: ["write_fs"],
  },
];

function useSeedDescriptors() {
  useEffect(() => {
    useApp.setState({ toolDescriptors: TOOL_DESCRIPTORS });
  }, []);
}

function PanelFrame({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <div className="dark flex min-h-screen items-center justify-center bg-[#0b0b12] p-10">
    <div className="flex h-[640px] w-[460px] flex-col overflow-hidden rounded-lg border border-border bg-background text-foreground shadow-2xl">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-2 text-xs font-semibold">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          Agent
        </div>
        <div className="rounded-md border border-border bg-card/60 px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
          llama-3.1-8b-instruct
        </div>
      </div>
      {children}
    </div>
    </div>
  );
}

export const ChatView: Story = () => (
  <PanelFrame>
    <div className="flex-1 space-y-3 overflow-auto px-3 py-3">
      {CHAT_MESSAGES.map((m) => (
        <MessageItem key={m.id} message={m} />
      ))}
      <ToolCallCard call={WRITE_CALL} />
      <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
        <span>thinking…</span>
      </div>
    </div>
    <div className="border-t border-border bg-card/40 p-2.5">
      <div className="relative">
        <div className="min-h-[64px] rounded-md border border-input bg-background px-3 py-2 pr-20 text-sm text-foreground">
          Now add unit tests for the providers form and run them.
        </div>
        <div className="absolute bottom-1.5 right-1.5 flex items-center gap-1">
          <div className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground">
            <Paperclip className="h-3.5 w-3.5" />
          </div>
          <div className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Send className="h-3.5 w-3.5" />
          </div>
        </div>
      </div>
      <div className="mt-1 text-[10px] text-muted-foreground">
        Enter to send · Shift+Enter for newline · / for commands
      </div>
    </div>
  </PanelFrame>
);

export const WorkflowPlanView: Story = () => {
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
    <PanelFrame>
      <div className="flex-1 overflow-auto py-3">
        <AgentRunFeedView events={[]} />
      </div>
    </PanelFrame>
  );
};

export const ToolApproval: Story = () => {
  useSeedDescriptors();
  const items: AgentWorkflowItem[] = [
    {
      type: "tool",
      id: APPROVAL_CALL.id,
      toolCall: APPROVAL_CALL,
      createdAt: APPROVAL_CALL.started_at ?? nowIso(),
    },
    {
      type: "permission",
      id: `permission-${APPROVAL_CALL.id}`,
      request: {
        id: APPROVAL_CALL.id,
        toolCall: APPROVAL_CALL,
        title: `Approve ${APPROVAL_CALL.name}`,
        summary: "The agent needs approval before running this command.",
      },
      createdAt: APPROVAL_CALL.started_at ?? nowIso(),
    },
    {
      type: "tool",
      id: WRITE_CALL.id,
      toolCall: WRITE_CALL,
      createdAt: WRITE_CALL.started_at ?? nowIso(),
    },
  ];
  useEffect(() => {
    useApp.setState({ agentItems: items });
  }, []);
  return (
    <PanelFrame>
      <div className="flex-1 space-y-2 overflow-auto px-3 py-3">
        <AgentRunFeedView events={[]} />
      </div>
    </PanelFrame>
  );
};
