/**
 * The per-model benchmark proxy — zoc-agent-chat-rebuild R13.11, R13.12, 9.9.
 *
 * Feature: zoc-agent-chat-rebuild, task 9.9 (R13.11, R13.12).
 *
 * ```
 * GET /v1/models/:id/benchmark
 *   → 200 { modelId, runCount, meanTokensPerSecond }
 *   → 502 { code: "workspace_unavailable" | "workspace_failed", retryable }
 * ```
 *
 * **A proxy, not an owner.** The store lives on Workspace_Services —
 * `zocai_gateway/benchmark.py`, persisting to `~/.zoc-studio/benchmarks.json` — and it
 * stays there. `benchmark` is the design's 26th capability group, `survives on
 * Workspace_Services, reached through the runtime`, and it needs a route here for one
 * reason: its only client today is `features/agent/gateway-client.ts`, inside the tree
 * 26.1 deletes.
 *
 * **The route reduces, which is why it is not a pass-through.** R13.11 makes the
 * history the model picker's data source, and what a picker row needs is one figure —
 * so the route answers the mean rather than making every renderer average an array and
 * agree on how. `runCount` travels with it because a mean over one run and a mean over
 * twenty are different claims.
 *
 * **No history is `null`, never `0` (R13.12).** Zero tokens per second is a legible
 * statement about a model and it would be a false one, so the picker lists an
 * unmeasured model with no figure at all — which it can only do if the route
 * distinguishes "never measured" from "measured as slow". An unknown model reaches here
 * as a 200 with an empty run list, so that distinction is data rather than a failure.
 */

import { meanTokensPerSecond } from "../agent/token-rate.ts";
import type { BenchmarkHistory, WorkspaceOutcome } from "../tools/workspace-client.ts";
import { HttpError, envelope } from "./errors.ts";
import { json, type Router } from "./routes.ts";

export interface BenchmarkRoutesDeps {
  /** Normally `WorkspaceClient.benchmarkHistory`. */
  benchmarkHistory(modelId: string): Promise<WorkspaceOutcome<BenchmarkHistory>>;
}

export function registerBenchmarkRoutes(router: Router, deps: BenchmarkRoutesDeps): void {
  router.get("/v1/models/:id/benchmark", async ({ res, params }) => {
    const modelId = params.id as string;
    const outcome = await deps.benchmarkHistory(modelId);

    if (!outcome.ok) {
      // 502 either way: the runtime reached for something on the caller's behalf and did
      // not get it. The client's `retryable` comes from the outcome rather than from the
      // status, so a 4xx refusal upstream does not offer a retry that cannot work.
      throw new HttpError(
        502,
        envelope(outcome.code, "The benchmark history could not be read.", {
          retryable: outcome.retryable,
        }),
      );
    }

    const runs = outcome.value.runs;
    json(res, 200, {
      modelId: outcome.value.modelId,
      runCount: runs.length,
      meanTokensPerSecond: meanTokensPerSecond(runs.map((run) => run.averageTokensPerSecond)),
    });
  });
}
