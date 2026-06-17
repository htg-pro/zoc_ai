import { describe, expect, it } from "vitest";
import {
  agentStateLabel,
  diagnosticsLabel,
  formatCursor,
  languageLabel,
  modelLabel,
} from "@/lib/status-bar";

describe("agentStateLabel", () => {
  it("reports busy while streaming or running", () => {
    expect(agentStateLabel({ streaming: true, isRunning: false, agentMode: "agent" })).toEqual({
      label: "Running",
      tone: "busy",
    });
    expect(agentStateLabel({ streaming: false, isRunning: true, agentMode: "ask" }).tone).toBe("busy");
  });
  it("reports the mode when idle", () => {
    expect(agentStateLabel({ streaming: false, isRunning: false, agentMode: "ask" })).toEqual({
      label: "Ask",
      tone: "ask",
    });
    expect(agentStateLabel({ streaming: false, isRunning: false, agentMode: "agent" })).toEqual({
      label: "Agent",
      tone: "idle",
    });
  });
});

describe("languageLabel", () => {
  it("maps known language ids to display names", () => {
    expect(languageLabel({ language: "typescript" })).toBe("TypeScript");
    expect(languageLabel({ language: "python" })).toBe("Python");
    expect(languageLabel({ language: "rust" })).toBe("Rust");
  });
  it("falls back to the file extension when language is plaintext/missing", () => {
    expect(languageLabel({ language: "plaintext", name: "main.rs" })).toBe("Rust");
    expect(languageLabel({ name: "app.tsx" })).toBe("TypeScript JSX");
  });
  it("capitalizes unknown languages and handles null", () => {
    expect(languageLabel({ language: "elixir" })).toBe("Elixir");
    expect(languageLabel(null)).toBe("—");
  });
});

describe("formatCursor", () => {
  it("formats a position or shows a dash", () => {
    expect(formatCursor({ line: 12, column: 5 })).toBe("Ln 12, Col 5");
    expect(formatCursor(null)).toBe("—");
  });
});

describe("modelLabel", () => {
  it("prefers the loaded local model and shortens paths", () => {
    expect(modelLabel({ provider: "llamacpp", model: "x" }, "models/Qwen2.5-Coder.gguf")).toBe(
      "Qwen2.5-Coder.gguf",
    );
    expect(modelLabel({ provider: "openai", model: "gpt-4o" }, null)).toBe("gpt-4o");
    expect(modelLabel({ provider: "llamacpp", model: "" }, null)).toBe("No model");
  });
});

describe("diagnosticsLabel", () => {
  it("summarizes errors and warnings", () => {
    expect(diagnosticsLabel(0, 0)).toBe("No problems");
    expect(diagnosticsLabel(3, 0)).toBe("3 errors");
    expect(diagnosticsLabel(1, 2)).toBe("1 error, 2 warnings");
  });
});
