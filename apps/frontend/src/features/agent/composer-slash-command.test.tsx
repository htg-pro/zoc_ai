import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "@/lib/store";
import { getActiveSelection } from "@/lib/editor-actions";

vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));
vi.mock("@/lib/editor-actions", () => ({ getActiveSelection: vi.fn() }));
vi.mock("./SlashAutocomplete", () => ({
  SlashAutocomplete: ({ onPick }: { onPick: (command: unknown) => void }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onPick({
            name: "test",
            mode: "agent",
            target: "file",
            summary: "Write tests for current file",
          })
        }
      >
        Choose test
      </button>
      <button
        type="button"
        onClick={() =>
          onPick({
            name: "explain",
            mode: "ask",
            target: "selection",
            summary: "Explain selected code",
          })
        }
      >
        Choose explain
      </button>
    </div>
  ),
}));
vi.mock("./MentionAutocomplete", () => ({ MentionAutocomplete: () => null }));
vi.mock("./AttachmentChips", () => ({ AttachmentChips: () => null }));
vi.mock("./MessageQueue", () => ({ MessageQueue: () => null }));
vi.mock("./RulesDialog", () => ({
  RulesDialog: ({ children }: { children: React.ReactNode }) => children,
}));

import { Composer } from "./Composer";

type MockState = Record<string, unknown>;
const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

function state(overrides: Partial<MockState> = {}): MockState {
  return {
    input: "/",
    setInput: vi.fn(),
    sendUserMessage: vi.fn(() => Promise.resolve()),
    queueUserMessage: vi.fn(),
    messageQueue: [],
    stopAndSend: vi.fn(),
    streaming: false,
    addAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    cancelStream: vi.fn(),
    activeFile: "/src/App.tsx",
    isRunning: false,
    autonomy: "Medium",
    setAutonomy: vi.fn(),
    reviewRunning: false,
    testGenRunning: false,
    testRunRunning: false,
    agentMode: "ask",
    setAgentMode: vi.fn(),
    projectRules: null,
    ...overrides,
  };
}

function renderWithState(current: MockState) {
  mockUseApp.mockImplementation((selector: (value: MockState) => unknown) =>
    selector(current),
  );
  return render(<Composer />);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Composer slash command selection", () => {
  it("prefills a file command, switches to Agent, and attaches the current file", () => {
    const current = state();
    renderWithState(current);

    fireEvent.click(screen.getByRole("button", { name: "Choose test" }));

    expect(current.clearAttachments).toHaveBeenCalled();
    expect(current.setAgentMode).toHaveBeenCalledWith("agent");
    expect(current.setInput).toHaveBeenCalledWith("Write tests for @App.tsx");
    expect(current.addAttachment).toHaveBeenCalledWith({
      label: "/src/App.tsx",
      kind: "file",
      path: "/src/App.tsx",
      token: "App.tsx",
    });
  });

  it("prefills an Ask command with the focused editor selection", () => {
    vi.mocked(getActiveSelection).mockReturnValue("const answer = 42;");
    const current = state();
    renderWithState(current);

    fireEvent.click(screen.getByRole("button", { name: "Choose explain" }));

    expect(current.setAgentMode).toHaveBeenCalledWith("ask");
    expect(current.setInput).toHaveBeenCalledWith(
      "Explain how the selected code works:\n\nconst answer = 42;",
    );
    expect(current.addAttachment).not.toHaveBeenCalled();
  });
});
