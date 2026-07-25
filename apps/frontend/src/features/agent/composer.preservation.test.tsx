/**
 * UI-preservation tests — Composer chrome, input echo, and Ask/Agent toggle.
 *
 * Feature: zoc-agent-ecosystem-merge, Task 4.4 — UI-preservation snapshot tests.
 *
 * These tests pin the preserved "green" Composer chrome of `Composer.tsx`: the
 * message input, the Ask/Agent mode toggle, the autonomy/priority pill (and the
 * Ask-mode Read-only pill), and the send/stop buttons. They assert the
 * preserved DOM structure, CSS classes, color tokens, and spacing via a
 * structural snapshot plus explicit class-list assertions, that the full set of
 * controls is retained, that typed text is echoed into the input (R1.3), and
 * that the Ask/Agent toggle indicator updates with the selected mode (R1.4).
 *
 * The store (`@/lib/store`) and the Composer's auxiliary children are mocked so
 * the chrome renders in isolation and the snapshots stay stable.
 *
 * Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

import { useApp } from "@/lib/store";

// --- Mock the store: useApp(selector) -> selector(state) --------------------
vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));

// --- Deterministic lucide-react icon stubs ---------------------------------
vi.mock("lucide-react", () => {
  const makeIcon = (name: string) => {
    const Icon = (props: { className?: string }) => (
      <span data-icon={name} className={props.className} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return {
    ArrowUp: makeIcon("ArrowUp"),
    ClipboardList: makeIcon("ClipboardList"),
    Paperclip: makeIcon("Paperclip"),
    ShieldCheck: makeIcon("ShieldCheck"),
    Square: makeIcon("Square"),
  };
});

// --- Mock the Composer's auxiliary children so only the chrome is tested ----
vi.mock("./SlashAutocomplete", () => ({
  SlashAutocomplete: () => <div data-testid="slash-stub" />,
}));
vi.mock("./MentionAutocomplete", () => ({
  MentionAutocomplete: () => <div data-testid="mention-stub" />,
}));
vi.mock("./AttachmentChips", () => ({
  AttachmentChips: () => <div data-testid="attachments-stub" />,
}));
vi.mock("./MessageQueue", () => ({
  MessageQueue: () => <div data-testid="queue-stub" />,
}));
vi.mock("./RulesDialog", () => ({
  RulesDialog: ({ children }: { children: ReactNode }) => (
    <div data-testid="rules-stub">{children}</div>
  ),
}));

// Imported after the mocks above are registered.
import { Composer } from "./Composer";

type AppState = Record<string, unknown>;

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

function applyState(state: AppState) {
  mockUseApp.mockImplementation((selector: (s: AppState) => unknown) =>
    selector(state),
  );
}

/** Full default state covering every field Composer selects. */
function baseState(overrides: Partial<AppState> = {}): AppState {
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
    agentMode: "ask",
    setAgentMode: vi.fn(),
    projectRules: null,
    ...overrides,
  };
}

/** The preserved Composer root element. */
function composerRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Composer preservation — chrome structure and tokens", () => {
  it("preserves the Composer DOM structure and class-list in Ask mode (snapshot)", () => {
    applyState(baseState({ agentMode: "ask" }));
    const { container } = render(<Composer />);
    expect(composerRoot(container)).toMatchSnapshot();
  });

  it("preserves the Composer DOM structure and class-list in Agent mode (snapshot)", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { container } = render(<Composer />);
    expect(composerRoot(container)).toMatchSnapshot();
  });

  it("preserves the outer container and input-card tokens", () => {
    applyState(baseState());
    const { container } = render(<Composer />);
    const root = composerRoot(container);
    expect(root.className).toContain("border-t");
    expect(root.className).toContain("border-[#1A1A1F]");
    expect(root.className).toContain("bg-[#0C0C10]");
    expect(root.className).toContain("p-3");
    const card = root.querySelector(".rounded-xl") as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card.className).toContain("bg-[#111116]");
    expect(card.className).toContain("border-[#26262B]");
  });

  it("retains the full set of controls in Agent mode", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText, getByLabelText, container } = render(<Composer />);
    expect(container.querySelector("textarea")).toBeInTheDocument();
    expect(getByText("Ask")).toBeInTheDocument();
    expect(getByText("Agent")).toBeInTheDocument();
    expect(getByLabelText("Autonomy level: Medium")).toBeInTheDocument();
    expect(getByLabelText("Send")).toBeInTheDocument();
  });

  it("preserves the enabled send and textarea tokens", () => {
    applyState(baseState({ agentMode: "agent", input: "run this" }));
    const { getByLabelText, container } = render(<Composer />);
    const send = getByLabelText("Send") as HTMLElement;
    expect(send.className).toContain("bg-[#7C3AED]");
    expect(send.className).toContain("border-[#9B6AF1]/30");
    expect(send.className).toContain("text-white");
    const textarea = container.querySelector("textarea") as HTMLElement;
    expect(textarea.className).toContain("text-[#EDEDF0]");
    expect(textarea.className).toContain("placeholder:text-[#3F3F46]");
  });
});

describe("Composer preservation — input echo (R1.3)", () => {
  it("displays the text held in the store input", () => {
    applyState(baseState({ input: "hello world" }));
    const { container } = render(<Composer />);
    const textarea = container.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello world");
  });

  it("echoes typed text back through the input change handler", () => {
    const setInput = vi.fn();
    applyState(baseState({ input: "", setInput }));
    const { container } = render(<Composer />);
    const textarea = container.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "type me" } });
    expect(setInput).toHaveBeenCalledWith("type me");
  });

  it("updates the placeholder with the active mode", () => {
    applyState(baseState({ agentMode: "ask" }));
    const ask = render(<Composer />);
    expect(
      ask.container.querySelector("textarea")?.getAttribute("placeholder"),
    ).toBe("Ask about your code…");
    cleanup();

    applyState(baseState({ agentMode: "agent" }));
    const agent = render(<Composer />);
    expect(
      agent.container.querySelector("textarea")?.getAttribute("placeholder"),
    ).toBe("Message the agent…");
  });
});

describe("Composer preservation — Ask/Agent toggle indicator (R1.4)", () => {
  it("marks Ask active and shows the Read-only pill in Ask mode", () => {
    applyState(baseState({ agentMode: "ask" }));
    const { getByText, getByLabelText } = render(<Composer />);
    const askBtn = getByText("Ask");
    const agentBtn = getByText("Agent");
    expect(askBtn.className).toContain("bg-[#1A3A5C]");
    expect(askBtn.className).toContain("text-[#60a5fa]");
    expect(agentBtn.className).not.toContain("bg-[#2A1F4E]");
    expect(getByLabelText("Read-only mode")).toBeInTheDocument();
  });

  it("marks Agent active and shows the autonomy pill in Agent mode", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText, getByLabelText } = render(<Composer />);
    const askBtn = getByText("Ask");
    const agentBtn = getByText("Agent");
    expect(agentBtn.className).toContain("bg-[#2A1F4E]");
    expect(agentBtn.className).toContain("text-[#9B6AF1]");
    expect(askBtn.className).not.toContain("bg-[#1A3A5C]");
    expect(getByLabelText("Autonomy level: Medium")).toBeInTheDocument();
  });

  it("switches the selected mode when a toggle option is clicked", () => {
    const setAgentMode = vi.fn();
    applyState(baseState({ agentMode: "ask", setAgentMode }));
    const { getByText } = render(<Composer />);
    fireEvent.click(getByText("Agent"));
    expect(setAgentMode).toHaveBeenCalledWith("agent");
    fireEvent.click(getByText("Ask"));
    expect(setAgentMode).toHaveBeenCalledWith("ask");
  });
});

describe("Composer preservation — send vs stop control", () => {
  it("shows the Send button when idle and disables it for empty input", () => {
    applyState(baseState({ input: "", streaming: false }));
    const { getByLabelText, queryByLabelText } = render(<Composer />);
    const send = getByLabelText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(queryByLabelText("Stop")).toBeNull();
  });

  it("enables the Send button when the input is non-empty", () => {
    applyState(baseState({ input: "do a thing", streaming: false }));
    const { getByLabelText } = render(<Composer />);
    const send = getByLabelText("Send") as HTMLButtonElement;
    expect(send.disabled).toBe(false);
  });

  it("shows the Stop control while streaming and hides Send", () => {
    applyState(baseState({ streaming: true }));
    const { getByLabelText, queryByLabelText } = render(<Composer />);
    expect(getByLabelText("Stop")).toBeInTheDocument();
    expect(queryByLabelText("Send")).toBeNull();
  });
});
