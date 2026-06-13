import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentPanel } from "@/features/agent/AgentPanel";
import { useApp, type AgentWorkflowItem, type ChatEntry } from "@/lib/store";

const initial = useApp.getState();

describe("AgentPanel single workflow timeline", () => {
  beforeEach(() => {
    useApp.setState({ ...initial });
  });

  it("does not blank the panel for unexpected tool status or payload values", async () => {
    const toolEntry: ChatEntry = {
      kind: "tool_call",
      id: "tc-weird",
      toolCall: {
        id: "tc-weird",
        name: "custom.tool",
        arguments: { count: BigInt(7) },
        status: "queued" as never,
        result: { ok: true },
      },
    };
    useApp.setState({
      chat: [toolEntry],
      agentItems: [
        {
          type: "tool",
          id: "tc-weird",
          toolCall: toolEntry.toolCall!,
          createdAt: new Date().toISOString(),
        },
      ],
      loadToolDescriptors: vi.fn(async () => {}),
    });

    render(
      <TooltipProvider>
        <AgentPanel />
      </TooltipProvider>,
    );

    expect(await screen.findByText("custom.tool")).toBeInTheDocument();
    expect(screen.getAllByText("unknown").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /custom\.tool/i }));
    expect(screen.getByText(/"count": "7"/)).toBeInTheDocument();
  });

  it("renders the agent-authored to-do list in the single timeline without a tab row", async () => {
    const todos: AgentWorkflowItem = {
      type: "todos",
      id: "run-1-todos",
      createdAt: new Date().toISOString(),
      todos: [
        { id: "1", content: "Find theme provider", status: "completed" },
        { id: "2", content: "Add toggle component", status: "in_progress" },
        { id: "3", content: "Wire up theme context", status: "pending" },
      ],
    };
    useApp.setState({
      agentItems: [todos],
      loadReplitWorkflow: vi.fn(async () => {}),
    });

    render(
      <TooltipProvider>
        <AgentPanel />
      </TooltipProvider>,
    );

    // The to-do card renders with each agent-authored item.
    expect(await screen.findByText(/To-do/i)).toBeInTheDocument();
    expect(screen.getByText(/Find theme provider/i)).toBeInTheDocument();
    expect(screen.getByText(/Add toggle component/i)).toBeInTheDocument();
    expect(screen.getByText(/Wire up theme context/i)).toBeInTheDocument();
    // No tab row, and the timeline renders without crashing.
    expect(screen.queryByRole("tab", { name: "Chat" })).not.toBeInTheDocument();
    expect(screen.queryByText(/The agent timeline hit a render error/i)).not.toBeInTheDocument();
  });

  it("does not render removed Task progress cards for task workflow items", async () => {
    const task: AgentWorkflowItem = {
      type: "task",
      id: "task-inline",
      createdAt: new Date().toISOString(),
      task: {
        id: "task-inline",
        session_id: "s1",
        plan_id: null,
        title: "Inline task",
        summary: "Task appears in the single conversation timeline.",
        status: "queued",
        priority: "medium",
        depends_on: [],
        files_likely_changed: ["src/App.tsx"],
        done_looks_like: ["Timeline shows task progress"],
        test_plan: ["pnpm typecheck"],
        validation_attempts: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    };
    useApp.setState({
      agentItems: [task],
      replitTasks: [task.task],
      selectedReplitTaskId: null,
      replitTaskLogs: {},
      loadReplitWorkflow: vi.fn(async () => {}),
    });

    render(
      <TooltipProvider>
        <AgentPanel />
      </TooltipProvider>,
    );

    // Task progress cards were removed from the timeline in the redesign.
    expect(screen.queryByText(/Task progress/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/The agent timeline hit a render error/i)).not.toBeInTheDocument();
  });

  it("groups a run's to-do list and diff into one unified Agent run card", async () => {
    const todos: AgentWorkflowItem = {
      type: "todos",
      id: "run-9-todos",
      createdAt: new Date().toISOString(),
      todos: [{ id: "1", content: "Add toggle component", status: "completed" }],
    };
    const diff: AgentWorkflowItem = {
      type: "diff",
      id: "diff-9",
      createdAt: new Date().toISOString(),
      patch: {
        id: "diff-9",
        file_path: "src/components/ThemeToggle.tsx",
        unified_diff:
          "--- a/src/components/ThemeToggle.tsx\n+++ b/src/components/ThemeToggle.tsx\n@@ -1 +1 @@\n-old\n+new\n",
        summary: "Add toggle",
      },
    };
    useApp.setState({
      agentItems: [todos, diff],
      pendingPatches: [diff.type === "diff" ? diff.patch : (undefined as never)],
      loadReplitWorkflow: vi.fn(async () => {}),
    });

    render(
      <TooltipProvider>
        <AgentPanel />
      </TooltipProvider>,
    );

    // The unified Agent run card wraps both the to-do list and the diff.
    expect(await screen.findByText(/Agent run/i)).toBeInTheDocument();
    expect(screen.getByText(/To-do/i)).toBeInTheDocument();
    expect(screen.getByText(/Add toggle component/i)).toBeInTheDocument();
    expect(screen.getByText(/ThemeToggle\.tsx/i)).toBeInTheDocument();
  });
});
