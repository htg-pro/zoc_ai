/**
 * The runtime's route table, composed — zoc-agent-chat-rebuild 9.7, design.md:1404.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.7.
 *
 * One function that registers every group, so there is a single answer to "what
 * does this process expose". The groups themselves live in their own modules and
 * know nothing about each other; this file is the only place that knows there are
 * six of them.
 *
 * ```
 * GET  /health                          routes.ts (registered by buildRoutes)
 * POST /v1/runs                         run-routes.ts
 * GET  /v1/runs/:id/stream              run-routes.ts
 * POST /v1/runs/:id/cancel              run-routes.ts
 * POST /v1/runs/:id/approvals           permission-routes.ts
 * GET  /v1/permissions/audit            permission-routes.ts
 * POST /v1/classify-intent              permission-routes.ts
 * GET  /v1/providers                    catalogue-routes.ts
 * GET  /v1/models                       catalogue-routes.ts
 * GET  /v1/tools                        catalogue-routes.ts
 * GET  /v1/models/:id/benchmark         benchmark-routes.ts
 * POST /v1/sessions/:id/compact         compaction-routes.ts
 * POST /v1/sessions/:id/title           session-routes.ts
 * POST /v1/completions                  editor-routes.ts
 * POST /v1/inline-edit                  editor-routes.ts
 * ```
 *
 * M2's MCP control surface is registered here as concrete `/v1/mcp/*` routes. The
 * collection root itself remains undefined, so clients cannot mistake an empty 200
 * for a server/tool snapshot.
 *
 * **`deps` is one object per group rather than one flat bag.** The groups have
 * genuinely disjoint needs — the catalogue routes must not be able to reach the run
 * store, the title route must not be able to reach Workspace_Services — and keeping
 * them separate is what makes those statements true of the code rather than of the
 * intention.
 */

import { registerCatalogueRoutes, type CatalogueRoutesDeps } from "./catalogue-routes.ts";
import { registerBenchmarkRoutes, type BenchmarkRoutesDeps } from "./benchmark-routes.ts";
import { registerCompactionRoutes, type CompactionRouteDeps } from "./compaction-routes.ts";
import { registerEditorRoutes, type EditorRoutesDeps } from "./editor-routes.ts";
import { registerPermissionRoutes, type PermissionRoutesDeps } from "./permission-routes.ts";
import { registerMcpRoutes, type McpRouteDeps } from "./mcp-routes.ts";
import { registerRunRoutes, type RunRoutesDeps } from "./run-routes.ts";
import { registerSessionRoutes, type SessionRoutesDeps } from "./session-routes.ts";
import type { Router } from "./routes.ts";

export interface ApiDeps {
  readonly runs: RunRoutesDeps;
  readonly catalogue: CatalogueRoutesDeps;
  readonly benchmark: BenchmarkRoutesDeps;
  readonly sessions: SessionRoutesDeps;
  readonly editor: EditorRoutesDeps;
  readonly compaction: CompactionRouteDeps;
  readonly permissions: PermissionRoutesDeps;
  readonly mcp: McpRouteDeps;
}

export function registerApiRoutes(router: Router, deps: ApiDeps): void {
  registerRunRoutes(router, deps.runs);
  registerPermissionRoutes(router, deps.permissions);
  registerCatalogueRoutes(router, deps.catalogue);
  registerBenchmarkRoutes(router, deps.benchmark);
  registerCompactionRoutes(router, deps.compaction);
  registerSessionRoutes(router, deps.sessions);
  registerEditorRoutes(router, deps.editor);
  registerMcpRoutes(router, deps.mcp);
}
