/**
 * Composer destructive-intent banner (Part 7.1 wiring).
 *
 * Verifies the Composer surfaces the inline cautious-mode warning and drops the
 * run mode to "ask" when the draft text carries destructive intent, and that it
 * renders nothing / changes nothing for benign or empty input. Uses the REAL
 * `@/lib/destructive-intent` detector; only the store, trust side effect, and
 * auxiliary children are mocked so the detection→UI wiring is what's tested.
 */
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useApp } from "@/lib/store";
import { setRunMode } from "@/lib/trust";

vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));
vi.mock("@/lib/editor-actions", () => ({ getActiveSelection: vi.fn() }));
vi.mock("@/lib/trust", () => ({ setRunMode: vi.fn() }));
vi.mock("./SlashAutocomplete", () => ({ SlashAutocomplete: () => null }));
vi.mock("./MentionAutocomplete", () => ({ MentionAutocomplete: () => null }));
vi.mock("./AttachmentChips", () => ({ AttachmentChips: () => null }));
vi.mock("./MessageQueue", () => ({ MessageQueue: () => null }));
vi.mock("./RulesDialog", () => ({
  RulesDialog: ({ children }: { children: ReactNode }) => children,
}));

import { Composer } from "./Composer";

type MockState = Record<string, unknown>;
const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;
const mockSetRunMode = setRunMode as unknown as ReturnType<typeof vi.fn>;

function state(overrides: Partial<MockState> = {}): MockState {
  return {
    input: "",
    setInput: vi.fn(),
    sendUserMessage: vi.fn(() => Promise.resolve()),
    queueUserMessage: vi.fn(),
    messageQueue: [],
    stopAndSend: vi.fn(),
    streaming: false,
    addAttachment: vi.fn(),
    clearAttachments: vi.fn(),
    cancelStream: vi.fn(),
    activeFile: null,
    isRunning: false,
    autonomy: "Medium",
    setAutonomy: vi.fn(),
    reviewRunning: false,
    testGenRunning: false,
    testRunRunning: false,
    agentMode: "agent",
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

describe("Composer destructive-intent banner", () => {
  it("shows the cautious-mode warning and lowers autonomy for destructive input", () => {
    const setAutonomy = vi.fn();
    renderWithState(state({ input: "please rm -rf x", setAutonomy }));

    expect(
      screen.getByText(
        /Destructive intent detected \(rm -rf\)\. Running in cautious mode\./,
      ),
    ).toBeInTheDocument();
    expect(setAutonomy).toHaveBeenCalledWith("Low");
    expect(mockSetRunMode).toHaveBeenCalledWith("ask");
  });

  it("renders no banner and changes nothing for benign input", () => {
    renderWithState(state({ input: "hello world" }));

    expect(screen.queryByText(/Destructive intent detected/)).toBeNull();
    expect(mockSetRunMode).not.toHaveBeenCalled();
  });

  it("renders no banner for empty input", () => {
    renderWithState(state({ input: "" }));

    expect(screen.queryByText(/Destructive intent detected/)).toBeNull();
    expect(mockSetRunMode).not.toHaveBeenCalled();
  });
});
