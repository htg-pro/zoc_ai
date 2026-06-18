// Spec: chat-memory-session-system, Task 1.2 — unit tests for the extended
// AgentEvent envelope (optional `run_id`).
//
// The TypeScript `AgentEventBase` gained `run_id?: string | null` in task 1.1.
// These tests pin two guarantees:
//   1. An event object WITHOUT `run_id` still type-checks (the field is
//      optional) and round-trips through JSON unchanged.
//   2. An event object WITH `run_id` (string or null) round-trips through JSON.
//
// _Requirements: 1.2, 1.7_
import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  AgentEventBase,
  DoneEvent,
  MessageEvent,
} from "@zoc-studio/shared-types";

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("AgentEvent envelope: optional run_id (task 1.2)", () => {
  it("an event without run_id type-checks and round-trips through JSON", () => {
    // No `run_id` key — compiles because the field is optional.
    const event: MessageEvent = {
      type: "message",
      session_id: "s1",
      seq: 1,
      at: new Date(0).toISOString(),
      message: {
        id: "m1",
        role: "user",
        content: "hi",
        created_at: new Date(0).toISOString(),
      },
    };

    // The field is genuinely absent (not just undefined-valued).
    expect("run_id" in event).toBe(false);

    const restored = roundTrip(event);
    expect(restored).toEqual(event);
    // JSON.stringify drops absent optional keys, so it stays absent.
    expect("run_id" in restored).toBe(false);
  });

  it("the base envelope without run_id type-checks and round-trips", () => {
    const base: AgentEventBase = {
      session_id: "s1",
      seq: 7,
      at: new Date(0).toISOString(),
    };

    const restored = roundTrip(base);
    expect(restored).toEqual(base);
    expect(restored.run_id).toBeUndefined();
  });

  it("an event with an explicit run_id round-trips through JSON", () => {
    const event: DoneEvent = {
      type: "done",
      session_id: "s1",
      seq: 2,
      at: new Date(0).toISOString(),
      run_id: "R2",
      ok: true,
      summary: null,
    };

    const restored = roundTrip(event);
    expect(restored).toEqual(event);
    expect(restored.run_id).toBe("R2");
  });

  it("an event with run_id explicitly null round-trips through JSON", () => {
    const event: AgentEvent = {
      type: "message",
      session_id: "s1",
      seq: 3,
      at: new Date(0).toISOString(),
      run_id: null,
      message: {
        id: "m2",
        role: "assistant",
        content: "ok",
        created_at: new Date(0).toISOString(),
      },
    };

    const restored = roundTrip(event);
    expect(restored).toEqual(event);
    // run_id present and null is preserved (JSON keeps null values).
    expect("run_id" in restored).toBe(true);
    expect(restored.run_id).toBeNull();
  });
});
