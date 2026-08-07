/**
 * Property 71: The Capability_Policy is total and every verdict matches the table.
 * Validates R32.3, R32.4, R32.7, R32.10.
 *
 * Feature: zoc-agent-chat-rebuild, Property 71 (R32.3, R32.4, R32.7, R32.10).
 *
 * Runs **exhaustively over the full domain** rather than sampled. 18 cells is the
 * entire (Conversation_Mode × Plan_Approval × Capability) product, so enumeration
 * is both cheaper and stronger than 100 draws over the same space — and it is
 * what turns "every cell is defined" from a hope into a claim.
 */

import { describe, expect, it } from "vitest";
import type { Capability, ConversationMode, ToolKind } from "@zoc-studio/shared-types";

import {
  CAPABILITIES,
  CONVERSATION_MODES,
  MODE_NOT_PERMITTED,
  PERMISSIONS,
  READ_CLASS_CONTROL_TOOLS,
  TOOL_KINDS,
  capabilityOf,
  checkCapability,
  policyKeys,
  type PolicyKey,
} from "../capability-policy.ts";

/**
 * Table A, transcribed independently of the implementation.
 *
 * Written out here as a *second* literal rather than imported, so the test is a
 * check against the design's table and not a tautology against the code's.
 */
const TABLE_A: ReadonlyArray<readonly [ConversationMode, boolean, Capability, boolean]> = [
  ["ask", false, "read", true],
  ["ask", false, "write", false],
  ["ask", false, "execute", false],
  ["ask", true, "read", true],
  ["ask", true, "write", false],
  ["ask", true, "execute", false],
  ["plan", false, "read", true],
  ["plan", false, "write", false],
  ["plan", false, "execute", false],
  ["plan", true, "read", true],
  ["plan", true, "write", true],
  ["plan", true, "execute", true],
  ["agent", false, "read", true],
  ["agent", false, "write", true],
  ["agent", false, "execute", true],
  ["agent", true, "read", true],
  ["agent", true, "write", true],
  ["agent", true, "execute", true],
];

describe("Property 71: the Capability_Policy is total (R32.3, R32.4, R32.7, R32.10)", () => {
  it("contains exactly eighteen keys", () => {
    // Exactly, not at least: an absent cell would read as a refusal by
    // falsiness, which is indistinguishable at runtime from a deliberate `false`
    // and means something entirely different.
    expect(policyKeys()).toHaveLength(18);
    expect(TABLE_A).toHaveLength(18);
  });

  it("defines a verdict for every point in the domain", () => {
    for (const mode of CONVERSATION_MODES) {
      for (const planApproved of [false, true]) {
        for (const capability of CAPABILITIES) {
          const key: PolicyKey = `${mode}:${planApproved}:${capability}`;
          expect(
            Object.prototype.hasOwnProperty.call(PERMISSIONS, key),
            `missing cell ${key}`,
          ).toBe(true);
          expect(typeof PERMISSIONS[key]).toBe("boolean");
        }
      }
    }
  });

  it("matches Table A cell for cell", () => {
    for (const [mode, planApproved, capability, expected] of TABLE_A) {
      const decision = checkCapability(mode, planApproved, capability);
      expect(decision.permitted, `${mode}:${planApproved}:${capability}`).toBe(expected);
    }
  });

  it("carries the typed code and a clean message on every refusal", () => {
    for (const [mode, planApproved, capability, expected] of TABLE_A) {
      const decision = checkCapability(mode, planApproved, capability);
      if (expected) {
        expect(decision.code).toBeUndefined();
        expect(decision.message).toBeUndefined();
        continue;
      }
      expect(decision.code).toBe(MODE_NOT_PERMITTED);
      const message = decision.message as string;
      expect(message.length).toBeGreaterThan(0);
      // No identifiers, no paths (R32.12).
      expect(message).not.toMatch(/\//);
      expect(message).not.toMatch(/run_|call_|req_/);
      expect(message.endsWith(".")).toBe(true);
    }
  });

  it("permits read in every mode and both approval states", () => {
    for (const mode of CONVERSATION_MODES) {
      for (const planApproved of [false, true]) {
        expect(checkCapability(mode, planApproved, "read").permitted).toBe(true);
      }
    }
  });

  it("refuses write and execute in ask regardless of approval (R32.4)", () => {
    for (const planApproved of [false, true]) {
      expect(checkCapability("ask", planApproved, "write").permitted).toBe(false);
      expect(checkCapability("ask", planApproved, "execute").permitted).toBe(false);
    }
  });

  it("makes approval the only difference in plan mode (R32.7)", () => {
    expect(checkCapability("plan", false, "write").permitted).toBe(false);
    expect(checkCapability("plan", true, "write").permitted).toBe(true);
    expect(checkCapability("plan", false, "execute").permitted).toBe(false);
    expect(checkCapability("plan", true, "execute").permitted).toBe(true);
  });

  it("makes approval irrelevant in agent mode (R32.10)", () => {
    for (const capability of CAPABILITIES) {
      expect(checkCapability("agent", false, capability).permitted).toBe(
        checkCapability("agent", true, capability).permitted,
      );
    }
  });

  it("is a frozen record, so no caller can widen the policy at runtime", () => {
    expect(Object.isFrozen(PERMISSIONS)).toBe(true);
  });

  it("returns a frozen decision", () => {
    expect(Object.isFrozen(checkCapability("ask", false, "write"))).toBe(true);
    expect(Object.isFrozen(checkCapability("agent", false, "write"))).toBe(true);
  });
});

describe("capabilityOf: six ToolKinds onto three Capabilities", () => {
  const EXPECTED: ReadonlyArray<readonly [ToolKind, Capability]> = [
    ["read", "read"],
    // A local index query mutates nothing; the separate kind exists for the
    // timeline's shape vocabulary, not for gating.
    ["search", "read"],
    ["write", "write"],
    ["execute", "execute"],
    // Locally executed by default — the strictest reading.
    ["network", "execute"],
    ["mcp", "execute"],
  ];

  it("maps every kind, with one case per kind", () => {
    expect(TOOL_KINDS).toHaveLength(6);
    for (const [kind, expected] of EXPECTED) {
      expect(capabilityOf(kind), kind).toBe(expected);
    }
  });

  it("splits network on who executes the call", () => {
    // Locally executed: `execute`. Classing it `read` would let Ask mode send
    // workspace content to a third party.
    expect(capabilityOf("network")).toBe("execute");
    expect(capabilityOf("network", { providerExecuted: false })).toBe("execute");
    // Provider-executed: `read`. Reaches no new host and sends nothing the
    // runtime was not already sending under that key.
    expect(capabilityOf("network", { providerExecuted: true })).toBe("read");
  });

  it("lets Ask mode use a provider-executed search but never a local one", () => {
    const providerSearch = capabilityOf("network", { providerExecuted: true });
    const localCall = capabilityOf("network", { providerExecuted: false });
    expect(checkCapability("ask", false, providerSearch).permitted).toBe(true);
    expect(checkCapability("ask", false, localCall).permitted).toBe(false);
  });

  it("narrows mcp only on the user's declaration, never a wider one", () => {
    expect(capabilityOf("mcp", { userDeclaredCapability: "read" })).toBe("read");
    // A declaration that would *widen* is ignored: the gated party does not get
    // to grant itself a permission.
    expect(capabilityOf("mcp", { userDeclaredCapability: "write" })).toBe("execute");
    expect(capabilityOf("mcp", { userDeclaredCapability: "execute" })).toBe("execute");
    expect(capabilityOf("mcp", {})).toBe("execute");
  });

  it("never widens a non-mcp kind through the declaration argument", () => {
    for (const kind of TOOL_KINDS) {
      if (kind === "mcp" || kind === "network") continue;
      expect(capabilityOf(kind, { userDeclaredCapability: "execute" })).toBe(capabilityOf(kind));
    }
  });
});

describe("read-class control tools (R32.11)", () => {
  it("classes plan production and completion as read", () => {
    expect(READ_CLASS_CONTROL_TOOLS.has("propose_plan")).toBe(true);
    expect(READ_CLASS_CONTROL_TOOLS.has("declare_complete")).toBe(true);
  });

  it("lets Agent mode produce a plan even under a deny policy", () => {
    // R32.11 with no special case: a plan is read-class, so the Run reports the
    // change it would make and leaves the workspace unmodified.
    expect(checkCapability("agent", false, "read").permitted).toBe(true);
  });

  it("does not include any workspace-mutating tool", () => {
    expect(READ_CLASS_CONTROL_TOOLS.has("workspace_apply_hunks")).toBe(false);
    expect(READ_CLASS_CONTROL_TOOLS.has("workspace_run_command")).toBe(false);
  });
});

describe("purity", () => {
  it("returns the same verdict for the same input, every time", () => {
    for (const [mode, planApproved, capability] of TABLE_A) {
      const first = checkCapability(mode, planApproved, capability);
      const second = checkCapability(mode, planApproved, capability);
      expect(first).toEqual(second);
    }
  });
});
