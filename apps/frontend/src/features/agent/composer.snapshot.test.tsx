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
    ArrowUp: icon("ArrowUp"),
    ClipboardList: icon("ClipboardList"),
    Paperclip: icon("Paperclip"),
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
    // The run gate now drives the send control: a ready model + an open
    // workspace let a non-empty message send; the mock provider carries no
    // reasoning-effort parameter, so that control stays hidden here.
    selectedModel: { provider: "mock", model: "mock-model" },
    llamaCppStatus: null,
    workspaceRoot: "/ws",
    activeRunMode: null,
    trackedRuns: [],
    maxConcurrentRuns: 3,
    ...overrides,
  };
}

/** The preserved Composer root element. */
function composerRoot(container: HTMLElement): HTMLElement {
  return container.firstElementChild as HTMLElement;
}

/** The control bar row: Ask/Agent toggle + pill + send/stop. */
function controlBar(container: HTMLElement): HTMLElement {
  const ask = Array.from(
    composerRoot(container).querySelectorAll<HTMLButtonElement>("button"),
  ).find((button) => button.textContent === "Ask");
  if (!ask?.parentElement?.parentElement) {
    throw new Error("Composer control bar not found");
  }
  return ask.parentElement.parentElement;
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
        class="flex flex-wrap items-center gap-1.5 px-2 pb-2 pt-1"
      >
        <div
          class="flex items-center rounded-lg border border-[#1E1E23] bg-[#0F0F14] p-0.5"
        >
          <button
            class="px-2.5 py-1 text-[11px] rounded-md font-medium transition-all text-[#52525B] hover:text-[#A1A1AA]"
            title="Ask: read-only Q&A"
            type="button"
          >
            Ask
          </button>
          <button
            class="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md font-medium transition-all text-[#52525B] hover:text-[#A1A1AA]"
            title="Plan: show the full plan and wait for approval before editing"
            type="button"
          >
            <span
              class="h-3 w-3"
              data-icon="ClipboardList"
            />
            Plan
          </button>
          <button
            class="px-2.5 py-1 text-[11px] rounded-md font-medium transition-all bg-[#2A1F4E] text-[#9B6AF1] shadow-sm"
            title="Agent: full autonomy"
            type="button"
          >
            Agent
          </button>
        </div>
        <button
          aria-label="Autonomy level: Medium"
          class="flex items-center gap-1.5 rounded-md border border-[#1E1E23] bg-[#0F0F14] px-2 py-0.5 text-[10.5px] text-[#71717A] transition-colors hover:bg-[#141419]"
          title="Autonomy: Medium — click to cycle"
          type="button"
        >
          <span
            class="h-1.5 w-1.5 rounded-full bg-[#9B6AF1]"
          />
          Medium
        </button>
        <div
          aria-label="Reasoning effort"
          class="flex items-center gap-0.5 rounded-md border border-[#1E1E23] bg-[#0F0F14] p-0.5 opacity-60"
          data-supported="false"
          data-testid="reasoning-effort"
          role="group"
          title="This model has no reasoning-effort setting"
        >
          <span
            class="px-1 text-[9px] uppercase tracking-wider text-[#52525B]"
          >
            Effort
          </span>
          <button
            aria-pressed="false"
            class="px-1.5 py-0.5 text-[10.5px] rounded font-medium capitalize transition-colors text-[#52525B] hover:text-[#A1A1AA] cursor-not-allowed"
            disabled=""
            title="Not supported by this model"
            type="button"
          >
            low
          </button>
          <button
            aria-pressed="false"
            class="px-1.5 py-0.5 text-[10.5px] rounded font-medium capitalize transition-colors text-[#52525B] hover:text-[#A1A1AA] cursor-not-allowed"
            disabled=""
            title="Not supported by this model"
            type="button"
          >
            medium
          </button>
          <button
            aria-pressed="false"
            class="px-1.5 py-0.5 text-[10.5px] rounded font-medium capitalize transition-colors text-[#52525B] hover:text-[#A1A1AA] cursor-not-allowed"
            disabled=""
            title="Not supported by this model"
            type="button"
          >
            high
          </button>
          <span
            class="px-1 text-[9px] lowercase text-[#52525B]"
          >
            n/a
          </span>
        </div>
        <div
          class="ml-auto flex items-center gap-1.5"
        >
          <button
            aria-label="Send"
            class="flex h-7 w-7 items-center justify-center rounded-lg border transition-all border-[#26262B] bg-[#15151A] text-[#3F3F46] cursor-not-allowed"
            disabled=""
            type="button"
          >
            <span
              class="h-3.5 w-3.5"
              data-icon="ArrowUp"
            />
          </button>
        </div>
      </div>
    `);
  });

  it("matches the preserved Ask-mode control-bar structure (inline snapshot)", () => {
    applyState(baseState({ agentMode: "ask" }));
    const { container } = render(<Composer />);
    expect(controlBar(container)).toMatchInlineSnapshot(`
      <div
        class="flex flex-wrap items-center gap-1.5 px-2 pb-2 pt-1"
      >
        <div
          class="flex items-center rounded-lg border border-[#1E1E23] bg-[#0F0F14] p-0.5"
        >
          <button
            class="px-2.5 py-1 text-[11px] rounded-md font-medium transition-all bg-[#1A3A5C] text-[#60a5fa] shadow-sm"
            title="Ask: read-only Q&A"
            type="button"
          >
            Ask
          </button>
          <button
            class="flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-md font-medium transition-all text-[#52525B] hover:text-[#A1A1AA]"
            title="Plan: show the full plan and wait for approval before editing"
            type="button"
          >
            <span
              class="h-3 w-3"
              data-icon="ClipboardList"
            />
            Plan
          </button>
          <button
            class="px-2.5 py-1 text-[11px] rounded-md font-medium transition-all text-[#52525B] hover:text-[#A1A1AA]"
            title="Agent: full autonomy"
            type="button"
          >
            Agent
          </button>
        </div>
        <span
          aria-label="Read-only mode"
          class="flex items-center gap-1 rounded-md border border-[#60a5fa]/20 bg-[#60a5fa]/8 px-2 py-0.5 text-[10.5px] text-[#60a5fa]"
          title="Ask mode: no files will change"
        >
          Read-only
        </span>
        <div
          aria-label="Reasoning effort"
          class="flex items-center gap-0.5 rounded-md border border-[#1E1E23] bg-[#0F0F14] p-0.5 opacity-60"
          data-supported="false"
          data-testid="reasoning-effort"
          role="group"
          title="This model has no reasoning-effort setting"
        >
          <span
            class="px-1 text-[9px] uppercase tracking-wider text-[#52525B]"
          >
            Effort
          </span>
          <button
            aria-pressed="false"
            class="px-1.5 py-0.5 text-[10.5px] rounded font-medium capitalize transition-colors text-[#52525B] hover:text-[#A1A1AA] cursor-not-allowed"
            disabled=""
            title="Not supported by this model"
            type="button"
          >
            low
          </button>
          <button
            aria-pressed="false"
            class="px-1.5 py-0.5 text-[10.5px] rounded font-medium capitalize transition-colors text-[#52525B] hover:text-[#A1A1AA] cursor-not-allowed"
            disabled=""
            title="Not supported by this model"
            type="button"
          >
            medium
          </button>
          <button
            aria-pressed="false"
            class="px-1.5 py-0.5 text-[10.5px] rounded font-medium capitalize transition-colors text-[#52525B] hover:text-[#A1A1AA] cursor-not-allowed"
            disabled=""
            title="Not supported by this model"
            type="button"
          >
            high
          </button>
          <span
            class="px-1 text-[9px] lowercase text-[#52525B]"
          >
            n/a
          </span>
        </div>
        <div
          class="ml-auto flex items-center gap-1.5"
        >
          <button
            aria-label="Send"
            class="flex h-7 w-7 items-center justify-center rounded-lg border transition-all border-[#26262B] bg-[#15151A] text-[#3F3F46] cursor-not-allowed"
            disabled=""
            type="button"
          >
            <span
              class="h-3.5 w-3.5"
              data-icon="ArrowUp"
            />
          </button>
        </div>
      </div>
    `);
  });
});

describe("Composer snapshot — preserved controls and tokens (R1.2, R1.5, R1.6)", () => {
  it("retains the full set of controls in Agent mode", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText, getByLabelText, container } = render(<Composer />);
    expect(container.querySelector("textarea")).toBeInTheDocument();
    expect(getByText("Ask")).toBeInTheDocument();
    expect(getByText("Agent")).toBeInTheDocument();
    expect(getByLabelText("Autonomy level: Medium")).toBeInTheDocument();
    expect(getByLabelText("Send")).toBeInTheDocument();
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

  it("preserves the toggle container tokens", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText } = render(<Composer />);
    const toggle = getByText("Ask").parentElement as HTMLElement;
    expect(toggle.className).toContain("bg-[#0F0F14]");
    expect(toggle.className).toContain("rounded-lg");
    expect(toggle.className).toContain("border-[#1E1E23]");
  });

  it("preserves the enabled send and textarea tokens", () => {
    applyState(baseState({ agentMode: "agent", input: "run this" }));
    const { getByLabelText, container } = render(<Composer />);
    const send = getByLabelText("Send") as HTMLElement;
    expect(send.className).toContain("bg-[#7C3AED]");
    expect(send.className).toContain("border-[#9B6AF1]/30");
    const textarea = container.querySelector("textarea") as HTMLElement;
    expect(textarea.className).toContain("text-[#EDEDF0]");
    expect(textarea.className).toContain("placeholder:text-[#3F3F46]");
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
    expect(getByText("Ask").className).toContain("bg-[#1A3A5C]");
    expect(getByText("Agent").className).not.toContain("bg-[#2A1F4E]");
    expect(getByLabelText("Read-only mode")).toBeInTheDocument();
  });

  it("marks Agent active and shows the autonomy pill in Agent mode", () => {
    applyState(baseState({ agentMode: "agent" }));
    const { getByText, getByLabelText } = render(<Composer />);
    expect(getByText("Agent").className).toContain("bg-[#2A1F4E]");
    expect(getByText("Ask").className).not.toContain("bg-[#1A3A5C]");
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
