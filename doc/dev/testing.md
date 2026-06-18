# Testing Guide

How to run and write tests across the three languages. Baselines as of this
writing: **197 backend** (pytest) and **121 frontend** (vitest) tests.

## Backend (pytest)

Run from the repo root with `uv`:

```bash
# Full suite — ALWAYS ignore smoke (it needs a live model and will hang)
uv run pytest services/agent/tests --ignore=services/agent/tests/smoke -q -p no:cacheprovider

# One file
uv run pytest services/agent/tests/test_zoc_run.py -q -p no:cacheprovider

# Quieter output (suppress the many 3rd-party deprecation warnings)
uv run pytest services/agent/tests --ignore=services/agent/tests/smoke -q -p no:warnings
```

- `services/agent/tests/smoke` requires a running model — exclude it in
  headless/CI runs.
- Tests use a `MockResponse`/`mock_provider` fixture to script LLM tool calls
  (see `test_zoc_run.py::_queue_write_run` for the pattern: queue a planner
  response, then tool-call responses, then a final text).
- Endpoint tests use the FastAPI `client` + `session` + `tmp_workspace`
  fixtures. To simulate a filesystem failure, `monkeypatch.setattr` on
  `zoc_run.shutil.copy2`.

## Frontend (vitest + fast-check)

Run from `apps/frontend/`:

```bash
node_modules/.bin/vitest run     # single run (no watch)
node_modules/.bin/tsc --noEmit   # typecheck
node_modules/.bin/eslint "src/**/*.{ts,tsx}"
```

- Pure modules use **property-based tests** (fast-check, ≥100 iterations) named
  `src/lib/__tests__/<module>.prop.test.ts` and tagged
  `// Feature: studio-ui-redesign, Property N: …`.
- Shared arbitraries live in `src/__tests__/arbitraries.ts`.
- Component/store tests use Vitest + Testing Library in `src/__tests__/`.

### Writing a property test (pattern)

```ts
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { myPureFn } from "../my-module";

describe("my-module (Property N)", () => {
  it("holds the invariant for all inputs", () => {
    fc.assert(
      fc.property(fc.array(fc.string()), (input) => {
        const out = myPureFn(input);
        expect(/* invariant on out */).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
```

## Rust (hotpath)

```bash
cargo test -p zoc-studio-hotpath
cargo clippy -p zoc-studio-hotpath
```

## All gates at once

```bash
make check    # lint + typecheck + tests across JS / Python / Rust
```

## Shell-output gotcha

In some tooling the terminal renders stdout as empty even on success. If you
can't see test output, redirect to a workspace file and read it back:

```bash
node_modules/.bin/vitest run > .vt.txt 2>&1; echo "EXIT=$?"
# then open .vt.txt
```

Clean up these scratch files when done — don't commit them.
