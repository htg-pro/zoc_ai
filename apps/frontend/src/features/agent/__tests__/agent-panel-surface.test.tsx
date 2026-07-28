// Feature: zoc-ai-agent-chat-overhaul, Task 21.2: typed error codes on the surface
//
// The AgentPanel consumes `surfaceState` (R19.1) and maps the typed error codes
// (R14.3, R14.5, R19.3, R19.6): `no_workspace` → workspace-required with a
// folder picker; `git_not_a_repository` → a benign notice with the feed still
// rendered; `git_command_failed` → a typed, retryable error surface.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { useApp } from "@/lib/store";
import { ErrorCodes } from "@/lib/errors";

vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));

vi.mock("@/lib/tauri-bridge", () => ({
  isTauri: () => true,
  pickDirectory: vi.fn(async () => null),
}));

vi.mock("lucide-react", () => {
  const icon = (name: string) => {
    const Icon = (props: { className?: string }) => (
      <span data-icon={name} className={props.className} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return {
    Zap: icon("Zap"),
    Pause: icon("Pause"),
    Play: icon("Play"),
    Square: icon("Square"),
    FilePenLine: icon("FilePenLine"),
    FolderOpen: icon("FolderOpen"),
    Plug: icon("Plug"),
    RefreshCw: icon("RefreshCw"),
  };
});

vi.mock("../ModelPicker", () => ({ ModelPicker: () => <div data-testid="model-picker-stub" /> }));
vi.mock("../AgentMenu", () => ({ AgentMenu: () => <div data-testid="agent-menu-stub" /> }));
vi.mock("../ContextBar", () => ({ ContextBar: () => <div data-testid="context-bar-stub" /> }));
vi.mock("../ContextLimitDialog", () => ({ ContextLimitDialog: () => null }));
vi.mock("../RunRegion", () => ({
  RunRegion: () => <div data-testid="run-region-stub" />,
  default: () => <div data-testid="run-region-stub" />,
}));
vi.mock("../Composer", () => ({ Composer: () => <div data-testid="composer-stub" /> }));
vi.mock("../ShareSessionDialog", () => ({ ViewerBanner: () => null }));
vi.mock("../AgentCrashBanner", () => ({ AgentCrashBanner: () => null }));
vi.mock("../AgentRunSwitcher", () => ({ AgentRunSwitcher: () => null }));
vi.mock("../TokenBudgetMeter", () => ({ TokenBudgetMeter: () => null }));

import { AgentPanel } from "../AgentPanel";

type AppState = Record<string, unknown>;
const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;
function applyState(state: AppState) {
  mockUseApp.mockImplementation((selector: (s: AppState) => unknown) => selector(state));
}

function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    contextStatus: null,
    streaming: false,
    agentMode: "agent",
    activeRunMode: null,
    reviewRunning: false,
    testGenRunning: false,
    testRunRunning: false,
    runBudget: null,
    cancelStream: vi.fn(),
    cancelRunById: vi.fn(),
    selectedModel: { provider: "mock", model: "mock-model" },
    autonomy: "Medium",
    agentPaused: false,
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    workspaceRoot: "/ws",
    openProjectInstructions: vi.fn(),
    trackedRuns: [],
    focusedRunId: null,
    maxConcurrentRuns: 3,
    focusRun: vi.fn(),
    runStartedAt: null,
    chat: [],
    liveMode: true,
    agentSurfaceError: null,
    boundMessageId: null,
    lastSentPrompt: "",
    requestComposerSubmit: vi.fn(),
    setWorkspaceRoot: vi.fn(async () => undefined),
    setAgentSurfaceError: vi.fn(),
    refreshGit: vi.fn(async () => undefined),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPanel surface states (Task 21.2)", () => {
  it("renders the transcript feed when connected with a workspace", () => {
    applyState(
      baseState({
        chat: [
          {
            kind: "message",
            id: "m1",
            message: { id: "m1", role: "user", content: "hi", created_at: "" },
          },
        ],
      }),
    );
    const { getByTestId } = render(<AgentPanel />);
    expect(getByTestId("run-region-stub")).toBeInTheDocument();
  });

  it("renders the rich empty state (model + mode + examples) when there are no rows", () => {
    applyState(baseState({ selectedModel: { provider: "mock", model: "mock-model" } }));
    const { getByTestId, queryByTestId } = render(<AgentPanel />);
    expect(getByTestId("agent-empty-state")).toBeInTheDocument();
    expect(queryByTestId("run-region-stub")).not.toBeInTheDocument();
  });

  it("maps no_workspace to the workspace-required state with a folder picker", () => {
    applyState(baseState({ workspaceRoot: null, agentMode: "agent" }));
    const { getByText, queryByTestId } = render(<AgentPanel />);
    expect(getByText("No workspace open")).toBeInTheDocument();
    expect(getByText(/Open folder/)).toBeInTheDocument();
    expect(queryByTestId("run-region-stub")).not.toBeInTheDocument();
  });

  it("maps git_not_a_repository to a benign notice that keeps the feed", () => {
    applyState(
      baseState({
        agentSurfaceError: {
          operation: "git",
          code: ErrorCodes.gitNotARepository,
          message: "This folder isn't a Git repository, so version-control actions are unavailable.",
          retryable: false,
        },
      }),
    );
    const { getByText, getByTestId } = render(<AgentPanel />);
    expect(getByText(/isn't a Git repository/)).toBeInTheDocument();
    // The chat still works alongside the notice.
    expect(getByTestId("run-region-stub")).toBeInTheDocument();
  });

  it("maps git_command_failed to a typed, retryable error surface", () => {
    applyState(
      baseState({
        agentSurfaceError: {
          operation: "git",
          code: ErrorCodes.gitCommandFailed,
          message: "A Git command failed. See the Logs panel for details.",
          retryable: true,
        },
      }),
    );
    const { getByText, queryByTestId } = render(<AgentPanel />);
    expect(getByText(/A Git command failed/)).toBeInTheDocument();
    expect(getByText("Retry")).toBeInTheDocument();
    expect(queryByTestId("run-region-stub")).not.toBeInTheDocument();
  });

  it("maps a lost connection to the disconnected state naming the Gateway with a Reconnect", () => {
    applyState(baseState({ liveMode: false, loadSessions: vi.fn(async () => undefined) }));
    const { getByText, getByTestId } = render(<AgentPanel />);
    expect(getByText("Gateway disconnected")).toBeInTheDocument();
    expect(getByTestId("gateway-reconnect")).toBeInTheDocument();
  });
});


describe("AgentPanel mode chrome", () => {
  it.each([
    ["ask", "Zoc Ask", "Read-only answers"],
    ["plan", "Zoc Plan", "Review before edits"],
    ["agent", "Zoc Agent", "Autonomous editing"],
  ] as const)("renders distinct %s title and subtitle", (agentMode, title, subtitle) => {
    applyState(baseState({ agentMode }));
    const { getByText } = render(<AgentPanel />);

    expect(
      getByText((_text, element) => element?.textContent === title),
    ).toBeInTheDocument();
    expect(getByText(subtitle)).toBeInTheDocument();
  });
});


describe("AgentPanel run-start Retry", () => {
  it("reuses the failed submission's bound user message", () => {
    const requestComposerSubmit = vi.fn();
    const setAgentSurfaceError = vi.fn();
    applyState(
      baseState({
        lastSentPrompt: "plan the migration",
        boundMessageId: "message-1",
        requestComposerSubmit,
        setAgentSurfaceError,
        agentSurfaceError: {
          operation: "run",
          code: ErrorCodes.contextWindowExceeded,
          message: "Reduce attached context, then retry.",
          retryable: true,
        },
      }),
    );
    const { getByText } = render(<AgentPanel />);

    fireEvent.click(getByText("Retry"));

    expect(setAgentSurfaceError).toHaveBeenCalledWith(null);
    expect(requestComposerSubmit).toHaveBeenCalledWith("plan the migration", {
      reuseMessageId: "message-1",
    });
  });
});
