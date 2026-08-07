/** Agent_Runtime MCP surface — zoc-agent-chat-rebuild R26.1, R26.3, R26.6. */
/** Feature: zoc-agent-chat-rebuild, task 30.2 (R26.1, R26.3, R26.4, R26.6). */
import { z } from "zod";

import type { McpControl } from "../mcp/control.ts";
import { ErrorCode, HttpError, envelope } from "./errors.ts";
import { json, type Router } from "./routes.ts";
import { readJsonBody, validate } from "./validate.ts";

export interface McpRouteDeps {
  readonly control: McpControl;
}

const toolPatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  capability: z.enum(["read", "execute"]).optional(),
});

const candidateSchema = z.record(z.string(), z.unknown());

function unavailable(outcome: { code: string; message: string; retryable: boolean }): never {
  throw new HttpError(
    outcome.retryable ? 503 : 502,
    envelope(ErrorCode.WORKSPACE_UNAVAILABLE, outcome.message, {
      details: outcome.code,
      retryable: outcome.retryable,
    }),
  );
}

export function registerMcpRoutes(router: Router, deps: McpRouteDeps): void {
  router.get("/v1/mcp/servers", async ({ res }) => {
    const snapshot = await deps.control.refresh();
    json(res, 200, snapshot);
  });

  router.patch("/v1/mcp/tools/:name", async ({ req, res, params }) => {
    const patch = validate(toolPatchSchema, await readJsonBody(req), "MCP tool setting");
    const tool = deps.control.updateTool(params.name as string, patch);
    if (tool === null) {
      throw HttpError.notFound(ErrorCode.NOT_FOUND, "That MCP tool is no longer available.");
    }
    json(res, 200, { tool });
  });

  router.post("/v1/mcp/reload", async ({ res }) => {
    const outcome = await deps.control.reload();
    if (!outcome.ok) unavailable(outcome);
    json(res, 200, outcome.value);
  });

  router.post("/v1/mcp/test", async ({ req, res }) => {
    const candidate = validate(candidateSchema, await readJsonBody(req), "MCP candidate");
    const outcome = await deps.control.test(candidate);
    if (!outcome.ok) unavailable(outcome);
    json(res, 200, outcome.value);
  });
}
