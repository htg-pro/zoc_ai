/**
 * UI-preservation SNAPSHOT tests — Composer control-bar chrome.
 *
 * Feature: zoc-agent-ecosystem-merge, Task 4.4 — UI-preservation snapshot tests.
 *
 * This file pins the preserved "green" Composer chrome of `Composer.tsx` with a
 * small structural inline snapshot of the control bar (the row holding the
 * Ask/Agent toggle, the autonomy/priority pill, and the send button) plus
 * explicit class-list / token assertions on each preserved control. It also
 * verifies the input echo (R1.3) and the Ask/Agent toggle indicator behavior
 * (R1.4). Explicit assertions are preferred over a giant brittle DOM snapshot,
 * with one inline snapshot scoped to the control bar only.
 *
 * The store (`@/lib/store`) and the Composer's auxiliary children are mocked so
 * the chrome renders in isolation and the snapshot stays stable.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";

import { useApp } from "@/lib/store";

// --- Mock the store: useApp(selector) -> selector(state) --------------------
vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));

// --- Deterministic lucide-react icon stubs ---------------------------------
// Explicit named exports for every icon Composer imports. (A Proxy factory does
// not survive vitest's module-namespace normalization, so the icons are named.)
vi.mock("lucide-react", () => {
  const icon = (name: string) => {
    const Icon = (props: { className?: string }) => (
      <span data-icon={name} className={props.className} />
    );
    Icon.displayName = name;
    return Icon;
  };
  return {
    __esModule: true,
    Paperclip: icon("Paperclip"),
    Send: icon("Send"),
    ShieldCheck: icon("ShieldCheck"),
    Square: icon("Square"),
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

/** The control bar row: Ask/Agent toggle + pill + send/stop. */
function controlBar(container: HTMLElement): HTMLElement {
  // The control row is the only element carrying the `mt-2.5` spacing token.
  return composerRoot(container).querySelector(".mt-2\\.5") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Composer snapshot — control-bar structure (R1.2, R1.5, R1.6)", () => {
  it("matches the preserved Agent-mode control-bar structure (inline snapshot)", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { container } = render(<Composer />);
    expect(controlBar(container)).toMatchInlineSnapshot(`
      <div
        class="mt-2.5 flex items-center gap-2"
      >
        <div
          class="flex items-center bg-[#1B1B21] rounded-full p-0.5 shrink-0 border border-[#26262B]"
        >
          <button
            class="px-3 py-0.5 text-[11px] rounded-full font-semibold transition-all text-[#71717A] hover:text-[#A1A1AA]"
            title="Ask: read-only Q&A about your code"
            type="button"
          >
            Ask
          </button>
          <button
            class="px-3 py-0.5 text-[11px] rounded-full font-semibold transition-all text-[#0b0e14] bg-[var(--zoc-ember)] shadow-sm"
            title="Agent: full autonomy — can edit files and run commands"
            type="button"
          >
            Agent
          </button>
        </div>
        <button
          aria-label="Autonomy level: Medium"
          class="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border border-[#26262B] bg-[#15151A] shrink-0 hover:bg-[#1B1B21] transition-colors"
          title="Autonomy: Medium (click to change)"
          type="button"
        >
          <span
            class="w-1.5 h-1.5 rounded-full bg-primary"
          />
          <span
            class="text-[11px] text-[#A1A1AA]"
          >
            Medium
          </span>
        </button>
        <button
          aria-label="Send"
          class="ml-auto w-7 h-7 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#9B6AF1] flex items-center justify-center shadow-[0_4px_12px_rgba(124,58,237,0.3)] disabled:opacity-40 disabled:pointer-events-none shrink-0"
          disabled=""
          type="button"
        >
          <span
            class="h-3 w-3 text-white"
            data-icon="Send"
          />
        </button>
      </div>
    `);
  });

  it("matches the preserved Ask-mode control-bar structure (inline snapshot)", () => {
    applyState(baseState({ agentMode: "ask" }));
    const { container } = render(<Composer />);
    expect(controlBar(container)).toMatchInlineSnapshot(`
      <div
        class="mt-2.5 flex items-center gap-2"
      >
        <div
          class="flex items-center bg-[#1B1B21] rounded-full p-0.5 shrink-0 border border-[#26262B]"
        >
          <button
            class="px-3 py-0.5 text-[11px] rounded-full font-semibold transition-all text-[#0b0e14] bg-[var(--zoc-info)] shadow-sm"
            title="Ask: read-only Q&A about your code"
            type="button"
          >
            Ask
          </button>
          <button
            class="px-3 py-0.5 text-[11px] rounded-full font-semibold transition-all text-[#71717A] hover:text-[#A1A1AA]"
            title="Agent: full autonomy — can edit files and run commands"
            type="button"
          >
            Agent
          </button>
        </div>
        <span
          aria-label="Read-only mode"
          class="flex items-center gap-1.5 px-1.5 py-0.5 rounded-md border border-[var(--zoc-info)]/40 bg-[var(--zoc-info)]/10 shrink-0"
          title="Ask mode is read-only — no files change"
        >
          <span
            class="w-1.5 h-1.5 rounded-full bg-[var(--zoc-info)]"
          />
          <span
            class="text-[11px] text-[#A1A1AA]"
          >
            Read-only
          </span>
        </span>
        <button
          aria-label="Send"
          class="ml-auto w-7 h-7 rounded-lg bg-gradient-to-br from-[#7C3AED] to-[#9B6AF1] flex items-center justify-center shadow-[0_4px_12px_rgba(124,58,237,0.3)] disabled:opacity-40 disabled:pointer-events-none shrink-0"
          disabled=""
          type="button"
        >
          <span
            class="h-3 w-3 text-white"
            data-icon="Send"
          />
        </button>
      </div>
    `);
  });
});

describe("Composer snapshot — preserved controls and tokens (R1.2, R1.5, R1.6)", () => {
  it("retains the full set of controls in Agent mode", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText, getByLabelText, container } = render(<Composer />);
    // Message input.
    expect(container.querySelector("textarea")).toBeInTheDocument();
    // Ask/Agent mode toggle.
    expect(getByText("Ask")).toBeInTheDocument();
    expect(getByText("Agent")).toBeInTheDocument();
    // Autonomy/priority pill (Agent mode).
    expect(getByLabelText("Autonomy level: Medium")).toBeInTheDocument();
    // Send button.
    expect(getByLabelText("Send")).toBeInTheDocument();
  });

  it("preserves the outer container border/background tokens and padding", () => {
    applyState(baseState());
    const { container } = render(<Composer />);
    const root = composerRoot(container);
    expect(root.className).toContain("border-t");
    expect(root.className).toContain("border-[#1E1E23]");
    expect(root.className).toContain("bg-[#101014]");
    expect(root.className).toContain("p-3");
    // Inner input card preserved tokens + radius.
    const card = root.querySelector(".rounded-\\[10px\\]") as HTMLElement;
    expect(card).toBeInTheDocument();
    expect(card.className).toContain("bg-[#131318]");
    expect(card.className).toContain("border-[#26262B]");
  });

  it("preserves the toggle pill container tokens", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText } = render(<Composer />);
    const toggle = getByText("Ask").parentElement as HTMLElement;
    expect(toggle.className).toContain("bg-[#1B1B21]");
    expect(toggle.className).toContain("rounded-full");
    expect(toggle.className).toContain("border-[#26262B]");
  });

  it("preserves the send button gradient and the textarea text token", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByLabelText, container } = render(<Composer />);
    const send = getByLabelText("Send") as HTMLElement;
    expect(send.className).toContain("from-[#7C3AED]");
    expect(send.className).toContain("to-[#9B6AF1]");
    const textarea = container.querySelector("textarea") as HTMLElement;
    expect(textarea.className).toContain("text-[#FAFAFA]");
    expect(textarea.className).toContain("placeholder:text-[#52525B]");
  });
});

describe("Composer snapshot — input echo (R1.3)", () => {
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
});

describe("Composer snapshot — Ask/Agent toggle indicator (R1.4)", () => {
  it("marks Ask active and shows the Read-only pill in Ask mode", () => {
    applyState(baseState({ agentMode: "ask" }));
    const { getByText, getByLabelText } = render(<Composer />);
    expect(getByText("Ask").className).toContain("bg-[var(--zoc-info)]");
    expect(getByText("Agent").className).not.toContain("bg-[var(--zoc-ember)]");
    expect(getByLabelText("Read-only mode")).toBeInTheDocument();
  });

  it("marks Agent active and shows the autonomy pill in Agent mode", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText, getByLabelText } = render(<Composer />);
    expect(getByText("Agent").className).toContain("bg-[var(--zoc-ember)]");
    expect(getByText("Ask").className).not.toContain("bg-[var(--zoc-info)]");
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
