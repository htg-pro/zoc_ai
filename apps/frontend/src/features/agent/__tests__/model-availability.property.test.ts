// Feature: zoc-ai-agent-chat-overhaul, Property 8: Model availability and the run-start gate agree with the readiness facts
// Feature: zoc-ai-agent-chat-overhaul, Property 11: Provider availability follows key presence and validity
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  type ModelAvailability,
  type RunGateCode,
  evaluateRunGate,
  localModelAvailability,
  providerAvailability,
  selectionKey,
} from "../model-availability";
import type { LocalModel } from "@/lib/local-models";
import type { ProviderConfig } from "@/lib/providers";
import type { LlamaCppStatus } from "@/lib/tauri-bridge";

const provider: ProviderConfig = {
  id: "openai",
  name: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  requiresKey: true,
  builtin: true,
  models: [],
};

describe("providerAvailability (Property 11)", () => {
  it("is selectable exactly when a valid key is present; keyless providers offer key entry", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (hasKey, keyInvalid) => {
        const a = providerAvailability(provider, hasKey, keyInvalid);
        const selectable = a.kind === "ready";
        expect(selectable).toBe(hasKey && !keyInvalid);
        if (!hasKey) {
          expect(a.kind).toBe("needs-key");
          if (a.kind === "needs-key") expect(a.provider).toBe("openai");
        } else if (keyInvalid) {
          expect(a.kind).toBe("key-invalid");
          if (a.kind === "key-invalid") expect(a.provider).toBe("openai");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("marks only the named provider invalid on an auth failure", () => {
    const other: ProviderConfig = { ...provider, id: "groq", name: "Groq" };
    const a = providerAvailability(provider, true, true);
    const b = providerAvailability(other, true, false);
    expect(a.kind).toBe("key-invalid");
    expect(b.kind).toBe("ready");
  });
});

describe("localModelAvailability (Property 8, file-missing)", () => {
  it("marks a model unavailable with a file-missing reason when its path is gone", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (path) => {
        const model: LocalModel = { id: "local:x", name: "x", path };
        const a = localModelAvailability(model, null, () => false);
        expect(a.kind).toBe("unavailable");
        if (a.kind === "unavailable") {
          expect(a.reason).toBe("file-missing");
          expect(a.path).toBe(path);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("reports ready only for the loaded model in the ready state", () => {
    const model: LocalModel = { id: "local:x", name: "x", path: "/m.gguf" };
    const readyStatus: LlamaCppStatus = {
      running: true,
      state: "ready",
      host: "127.0.0.1",
      port: 8080,
      base_url: "http://127.0.0.1:8080",
      loaded_model_id: "local:x",
      loaded_model_path: "/m.gguf",
      n_gpu_layers: null,
      n_ctx: null,
      n_threads: null,
      n_batch: null,
      temperature: null,
      top_p: null,
      top_k: null,
      repeat_penalty: null,
      max_tokens: null,
      flash_attn: null,
      last_error: null,
    };
    expect(localModelAvailability(model, readyStatus, () => true).kind).toBe("ready");
    // A different loaded model → this one is stopped.
    expect(
      localModelAvailability(model, { ...readyStatus, loaded_model_id: "other", loaded_model_path: "/o.gguf" }, () => true).kind,
    ).toBe("stopped");
  });
});

describe("evaluateRunGate (Property 8)", () => {
  const readyAvail: ModelAvailability = { kind: "ready", baseUrl: "http://x" };
  const notReadyAvail: ModelAvailability = { kind: "starting" };

  it("is enabled exactly under the readiness facts, and reports the first failing clause", () => {
    fc.assert(
      fc.property(
        fc.record({
          input: fc.oneof(fc.constant(""), fc.constant("   "), fc.string({ minLength: 1 }).map((s) => `x${s}`)),
          mode: fc.constantFrom("ask", "plan", "agent", "bogus"),
          hasSelection: fc.boolean(),
          modelReady: fc.boolean(),
          workspaceRoot: fc.option(fc.constant("/ws"), { nil: null }),
          readOnly: fc.boolean(),
          activeRunCount: fc.nat({ max: 3 }),
          maxConcurrentRuns: fc.integer({ min: 1, max: 3 }),
        }),
        (p) => {
          const selected = p.hasSelection ? { provider: "openai", model: "gpt-4o" } : null;
          const availability = new Map<string, ModelAvailability>();
          if (selected) {
            availability.set(selectionKey(selected), p.modelReady ? readyAvail : notReadyAvail);
          }
          const gate = evaluateRunGate({
            input: p.input,
            selected,
            availability,
            mode: p.mode,
            workspaceRoot: p.workspaceRoot,
            readOnly: p.readOnly,
            activeRunCount: p.activeRunCount,
            maxConcurrentRuns: p.maxConcurrentRuns,
          });

          // Reference clause order.
          const validMode = p.mode === "ask" || p.mode === "plan" || p.mode === "agent";
          let expected: RunGateCode | null = null;
          if (!validMode || p.input.trim().length === 0) expected = "invalid_request";
          else if (p.readOnly) expected = "read_only";
          else if (p.activeRunCount >= Math.max(1, p.maxConcurrentRuns)) expected = "run_active";
          else if (!selected) expected = "no_model_selected";
          else if (!p.modelReady) expected = "no_model_ready";
          else if (p.mode !== "ask" && (p.workspaceRoot ?? "").trim().length === 0)
            expected = "no_workspace";

          if (expected === null) {
            expect(gate.canStart).toBe(true);
          } else {
            expect(gate.canStart).toBe(false);
            if (!gate.canStart) expect(gate.code).toBe(expected);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it("enables the Ask carve-out with no resolved workspace", () => {
    const selected = { provider: "openai", model: "gpt-4o" };
    const availability = new Map<string, ModelAvailability>([
      [selectionKey(selected), readyAvail],
    ]);
    const gate = evaluateRunGate({
      input: "hello",
      selected,
      availability,
      mode: "ask",
      workspaceRoot: null,
      readOnly: false,
      activeRunCount: 0,
      maxConcurrentRuns: 1,
    });
    expect(gate.canStart).toBe(true);
  });
});
