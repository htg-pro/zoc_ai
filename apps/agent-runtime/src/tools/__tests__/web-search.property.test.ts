/** Property 90: provider web-search presence equals the supported-provider set. */
/** Feature: zoc-agent-chat-rebuild, Property 90 (R33.1, R33.2, R33.4). */

import { describe, expect, it } from "vitest";

import { DEFAULT_PERMISSION_CONFIG } from "../../permissions/engine.ts";
import {
  authorizeProviderExecutedTool,
  createAuditLog,
  createGrantLedger,
  type GateContext,
  type PermissionMode,
} from "../../permissions/gate.ts";
import { PROVIDERS } from "../../providers/registry.ts";
import { resolveKey, type SecretSource } from "../../providers/keys.ts";
import { buildToolDescriptors } from "../registry.ts";
import {
  NO_WEB_SEARCH_SENTENCE,
  WEB_SEARCH_PERMISSION_TOOL,
  supportsProviderWebSearch,
  webSearchToolFor,
  withoutWebSearch,
} from "../web-search.ts";
import type { ConversationMode } from "@zoc-studio/shared-types";
import type { WorkspaceClient } from "../workspace-client.ts";

const MODES: readonly ConversationMode[] = ["ask", "plan", "agent"];
const PERMISSION_MODES: readonly PermissionMode[] = ["ask", "auto", "deny"];

function gateHarness(mode: ConversationMode, permissionMode: PermissionMode) {
  const approvals: Array<{ toolName: string; offeredScopes: readonly string[] }> = [];
  const refusals: string[] = [];
  let brokerCalls = 0;
  const context: GateContext = {
    runId: "run-search",
    mode,
    permissionMode,
    policy: DEFAULT_PERMISSION_CONFIG,
    workspaceRoot: null,
    planApproval: { approved: mode === "plan", planId: null, approvedAt: null },
    planPaths: new Set(),
    writer: {
      modeRefusal: () => undefined,
      toolRefusal: (_toolName, reason) => refusals.push(reason),
      providerToolRefusal: (toolName) => refusals.push(toolName),
      approvalRequest: (request) => approvals.push(request),
      approvalTimeout: () => undefined,
      awaitingApproval: () => undefined,
    },
    broker: {
      request: async () => {
        brokerCalls += 1;
        return { decision: "approve", scope: "run" };
      },
    },
    grants: createGrantLedger(),
    audit: createAuditLog(),
    now: () => new Date(0),
  };
  return { context, approvals, refusals, brokerCalls: () => brokerCalls };
}

describe("Property 90: web-search tool presence equals the supported-provider set", () => {
  it("enumerates all six providers across all nine mode combinations", async () => {
    for (const provider of PROVIDERS) {
      for (const mode of MODES) {
        for (const permissionMode of PERMISSION_MODES) {
          const native = webSearchToolFor(provider.id);
          const gate = gateHarness(mode, permissionMode);
          const allowed =
            native !== null &&
            (await authorizeProviderExecutedTool(gate.context, {
              toolName: WEB_SEARCH_PERMISSION_TOOL,
              kind: "network",
            }));
          const descriptors = buildToolDescriptors({
            workspace: {} as WorkspaceClient,
            sessionId: "session-search",
            mode,
            gated: (_name, _kind, execute) => execute,
            proposePlan: null,
            providerTools: allowed && native !== null ? [native] : [],
          });
          const present =
            native !== null && descriptors.some((descriptor) => descriptor.name === native.name);
          const expected = supportsProviderWebSearch(provider.id) && permissionMode !== "deny";
          const where = `${provider.id}/${mode}/${permissionMode}`;
          expect(present, where).toBe(expected);

          const instructions = present ? "BASE" : withoutWebSearch("BASE");
          expect(instructions.includes(NO_WEB_SEARCH_SENTENCE), where).toBe(!expected);

          if (supportsProviderWebSearch(provider.id) && permissionMode === "deny") {
            expect(gate.refusals, where).toEqual([WEB_SEARCH_PERMISSION_TOOL]);
          } else {
            expect(gate.refusals, where).toEqual([]);
          }
          if (supportsProviderWebSearch(provider.id) && permissionMode === "ask") {
            expect(gate.approvals, where).toHaveLength(1);
            expect(gate.approvals[0]?.offeredScopes, where).toEqual(["run"]);
          }
        }
      }
    }
  });

  it("one run-scoped approval covers every later registration in the Run", async () => {
    const gate = gateHarness("ask", "ask");
    const input = { toolName: WEB_SEARCH_PERMISSION_TOOL, kind: "network" as const };
    expect(await authorizeProviderExecutedTool(gate.context, input)).toBe(true);
    expect(await authorizeProviderExecutedTool(gate.context, input)).toBe(true);
    expect(gate.brokerCalls()).toBe(1);
    expect(gate.approvals).toHaveLength(1);
  });

  it("resolves only the selected provider key and search adds no vault read", async () => {
    for (const providerId of ["openai", "anthropic", "google-ai-studio"] as const) {
      const reads: string[] = [];
      const secrets: SecretSource = {
        get: async (name) => {
          reads.push(name);
          return "test-key";
        },
      };
      await resolveKey(providerId, secrets);
      expect(webSearchToolFor(providerId)).not.toBeNull();
      expect(reads, providerId).toHaveLength(1);
    }
  });
});
