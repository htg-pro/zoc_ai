/**
 * The `@perf` tier's Vitest config — zoc-agent-chat-rebuild task 17.6.
 *
 * A second config rather than a flag on the first one. `vitest.config.ts` excludes `*.perf.test.*` so
 * the default gate never launches a browser, and Vitest 2 has no CLI override for `include` — so the
 * only way to run exactly the excluded files is to point it at a config whose `include` is those files.
 *
 * Two deviations from the default, both required rather than stylistic:
 *
 *   - **`pool: "forks"` and no file parallelism.** Each file launches a Chromium and a Vite server, and
 *     two of those competing for the same machine is exactly the interference that makes a frame-interval
 *     measurement meaningless.
 *   - **Long timeouts.** Vite's first-run dependency optimisation plus a browser launch is minutes on a
 *     cold cache, and the `longtask` guard streams for 30 s by design.
 */
import { defineConfig } from "vitest/config";

import base from "./vitest.config";

// Spread rather than `mergeConfig`: merging *concatenates* array options, so the base config's
// `exclude` — which is what keeps `*.perf.test.*` out of the default gate — would survive the merge and
// exclude the only files this config includes. Vitest then reports "No test files found", which is a
// confusing way to say the two configs disagree.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["src/**/*.perf.test.*"],
    exclude: ["node_modules", "dist"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    pool: "forks",
    fileParallelism: false,
  },
});
