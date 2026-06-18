/**
 * UI-preservation tests — AgentPanel header + active-execution control bar.
 *
 * Feature: zoc-agent-ecosystem-merge, Task 4.4 — UI-preservation snapshot tests.
 *
 * These tests pin the preserved "green" Panel_Shell chrome of `AgentPanel.tsx`:
 * the header row (Zap badge, "Zoc Agent"/"Zoc Ask" title, subtitle, status
 * pill, model selector slot, menu) and the active-execution control bar
 * (pause/resume, stop, elapsed timer, autonomy pill, model chip). They assert
 * the preserved DOM structure, CSS classes, color tokens, and spacing via a
 * structural snapshot plus explicit class-list assertions, and that the full
 * set of header controls is retained.
 *
 * The store (`@/lib/store`) and the body/sibling components are mocked so the
 * panel chrome renders in isolation and the snapshots stay stable.
 *
 * Validates: Requirements 1.1, 1.5, 1.6
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { useApp } from "@/lib/store";

// --- Mock the store: useApp(selector) -> selector(state) --------------------
vi.mock("@/lib/store", () => ({ useApp: vi.fn() }));

// --- Deterministic lucide-react icon stubs (any icon -> labelled span) ------
vi.mock("lucide-react", () => {
  const handler: ProxyHandler<Record<string, unknown>> = {
    get: (_target, name) => {
      // Only resolve real (string) icon names. Returning a value for `then`
      // or other special keys would make the mocked module look like a
      // thenable and deadlock the async ESM import.
      if (typeof name !== "string" || name === "then" || name === "__esModule") {
        return undefined;
      }
      const Icon = (props: { className?: string }) => (
        <span data-icon={String(name)} className={props.className} />
      );
      Icon.displayName = String(name);
      return Icon;
    },
  };
  return new Proxy({}, handler);
});

// --- Mock sibling/body components so only the chrome is under test ----------
vi.mock("./ModelPicker", () => ({
  ModelPicker: () => <div data-testid="model-picker-stub" />,
}));
vi.mock("./AgentMenu", () => ({
  AgentMenu: () => <div data-testid="agent-menu-stub" />,
}));
vi.mock("./ContextBar", () => ({
  ContextBar: () => <div data-testid="context-bar-stub" />,
}));
vi.mock("./ContextLimitDialog", () => ({
  ContextLimitDialog: () => null,
}));
vi.mock("./RunRegion", () => ({
  RunRegion: () => <div data-testid="run-region-stub" />,
  default: () => <div data-testid="run-region-stub" />,
}));
vi.mock("./Composer", () => ({
  Composer: () => <div data-testid="composer-stub" />,
}));

// Imported after the mocks above are registered.
import { AgentPanel } from "./AgentPanel";

type AppState = Record<string, unknown>;

const mockUseApp = useApp as unknown as ReturnType<typeof vi.fn>;

function applyState(state: AppState) {
  mockUseApp.mockImplementation((selector: (s: AppState) => unknown) =>
    selector(state),
  );
}

/** Full default state covering every field AgentPanel selects. */
function baseState(overrides: Partial<AppState> = {}): AppState {
  return {
    contextStatus: null,
    streaming: false,
    agentMode: "agent",
    reviewRunning: false,
    testGenRunning: false,
    testRunRunning: false,
    cancelStream: vi.fn(),
    selectedModel: { model: "openai/gpt-4o-mini" },
    autonomy: "Medium",
    agentPaused: false,
    pauseAgent: vi.fn(),
    resumeAgent: vi.fn(),
    ...overrides,
  };
}

/** The preserved header region (grid row 1). */
function header(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>(".row-start-1");
  if (!el) throw new Error("header (.row-start-1) not found");
  return el;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentPanel preservation — header chrome (idle)", () => {
  beforeEach(() => {
    applyState(baseState({ agentMode: "agent", streaming: false }));
  });

  it("preserves the header DOM structure and class-list (snapshot)", () => {
    const { container } = render(<AgentPanel />);
    expect(header(container)).toMatchSnapshot();
  });

  it("preserves the four-row grid layout and background token", () => {
    const { container } = render(<AgentPanel />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toContain(
      "grid-rows-[auto_auto_minmax(0,1fr)_auto]",
    );
    expect(root.className).toContain("grid-cols-1");
    expect(root.className).toContain("bg-background");
    // The four grid rows are preserved in order.
    expect(container.querySelector(".row-start-1")).toBeInTheDocument();
    expect(container.querySelector(".row-start-2")).toBeInTheDocument();
    expect(container.querySelector(".row-start-3")).toBeInTheDocument();
    expect(container.querySelector(".row-start-4")).toBeInTheDocument();
  });

  it("preserves header border/background tokens and spacing", () => {
    const { container } = render(<AgentPanel />);
    const head = header(container);
    expect(head.className).toContain("border-b");
    expect(head.className).toContain("border-[#1E1E23]");
    expect(head.className).toContain("bg-[#101014]");
    // Top-bar row spacing preserved.
    const topBar = head.querySelector(".min-h-\\[44px\\]") as HTMLElement;
    expect(topBar).toBeInTheDocument();
    expect(topBar.className).toContain("px-3");
    expect(topBar.className).toContain("py-1.5");
    expect(topBar.className).toContain("gap-2.5");
  });

  it("preserves the ember Zap badge with its color tokens", () => {
    const { container } = render(<AgentPanel />);
    const badge = container.querySelector(
      ".text-\\[var\\(--zoc-ember\\)\\]",
    ) as HTMLElement;
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("bg-[rgba(251,146,60,0.12)]");
    expect(badge.className).toContain("border-[rgba(251,146,60,0.28)]");
    expect(badge.querySelector('[data-icon="Zap"]')).toBeInTheDocument();
  });

  it("renders the 'Zoc Agent' title with the ember accent word", () => {
    const { container } = render(<AgentPanel />);
    const head = header(container);
    expect(head.textContent).toContain("Zoc");
    expect(head.textContent).toContain("Agent");
    // The accent header word carries the ember color token.
    const accentWord = Array.from(head.querySelectorAll("span")).find(
      (s) =>
        s.textContent === "Agent" &&
        s.className.includes("text-[var(--zoc-ember)]"),
    );
    expect(accentWord).toBeTruthy();
  });

  it("retains the idle status pill and the header controls (model selector + menu)", () => {
    const { getByText, getByTestId } = render(<AgentPanel />);
    expect(getByText("idle")).toBeInTheDocument();
    expect(getByTestId("model-picker-stub")).toBeInTheDocument();
    expect(getByTestId("agent-menu-stub")).toBeInTheDocument();
  });

  it("shows the 'Ask' header word and read-only subtitle in Ask mode", () => {
    applyState(baseState({ agentMode: "ask", streaming: false }));
    const { container } = render(<AgentPanel />);
    const head = header(container);
    expect(head.textContent).toContain("Ask");
    expect(head.textContent).toContain("Read-only answers");
  });
});

describe("AgentPanel preservation — active-execution control bar (running)", () => {
  beforeEach(() => {
    applyState(
      baseState({
        streaming: true,
        agentPaused: false,
        agentMode: "agent",
        autonomy: "Medium",
        selectedModel: { model: "anthropic/claude-3-5-sonnet" },
      }),
    );
  });

  it("preserves the control-bar DOM structure and class-list (snapshot)", () => {
    const { container } = render(<AgentPanel />);
    expect(header(container)).toMatchSnapshot();
  });

  it("retains pause, stop, timer, autonomy pill and model chip controls", () => {
    const { getByTitle, container } = render(<AgentPanel />);
    // Pause control (resume when paused).
    expect(getByTitle("Pause run")).toBeInTheDocument();
    // Stop control with its destructive color tokens.
    const stop = getByTitle("Stop run") as HTMLElement;
    expect(stop.className).toContain("bg-[rgba(248,113,113,0.12)]");
    expect(stop.className).toContain("border-[rgba(248,113,113,0.3)]");
    expect(stop.className).toContain("text-[#F87171]");
    // Elapsed timer (monospace).
    const timer = container.querySelector(".font-mono") as HTMLElement;
    expect(timer).toBeInTheDocument();
    // Autonomy pill reflects current level.
    expect(getByTitle("Autonomy level: Medium")).toBeInTheDocument();
    // Model chip shows the trailing model id.
    expect(
      getByTitle("anthropic/claude-3-5-sonnet"),
    ).toBeInTheDocument();
  });

  it("shows the running status pill with a pulsing dot", () => {
    const { getByText, container } = render(<AgentPanel />);
    expect(getByText("Building…")).toBeInTheDocument();
    expect(container.querySelector(".animate-pulse-dot")).toBeInTheDocument();
  });

  it("renders the resume control when the run is paused", () => {
    applyState(
      baseState({ streaming: true, agentPaused: true, agentMode: "agent" }),
    );
    const { getByText, getByTitle } = render(<AgentPanel />);
    expect(getByTitle("Resume run")).toBeInTheDocument();
    expect(getByText("Paused")).toBeInTheDocument();
  });
});
