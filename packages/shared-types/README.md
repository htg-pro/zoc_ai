# `@llama-studio/shared-types` / `llama-studio-shared-schema`

Single source of truth for cross-language types.

- **Python**: `packages/shared-types/python/shared_schema` — Pydantic v2 models.
- **TypeScript**: `packages/shared-types/typescript/src/index.ts` — consumed
  by the frontend as `@llama-studio/shared-types`.

The Python package is authoritative. Regenerate the TS twin with:

```bash
pnpm schema:generate
```

Phase 1 ships a hand-mirrored TS file so the frontend compiles without the
codegen toolchain. CI will enforce drift once Phase 4 wires the generator
into `make check`.
