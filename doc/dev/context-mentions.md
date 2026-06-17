# @-context mentions

Type `@` in the composer to open a picker of workspace **files**, **folders**,
and code **symbols**, and insert a reference into your message — richer than the
old single `@file` swap.

## Flow

```
type "@que" → detectMentionQuery(text, caret) → picker opens
   │  GET /v1/sessions/{id}/context/search?q=que
   ├─ files + folders ranked from the workspace file list (iter_files)
   ├─ symbols (best-effort) from the code index
   └─ pick → applyMention() inserts "@<path> " + records an attachment chip
```

## Backend

- `agent/context_search.py` — pure `fuzzy_score()` + `search_files()` over
  `iter_files(root)` (files + derived folders), substring-beats-subsequence,
  basename-weighted ranking.
- `v1/context.py` — `GET /sessions/{id}/context/search?q=&limit=` →
  `ContextCandidate[]` (kind file/folder/symbol). Symbols come from
  `indexer.query()` best-effort (skipped silently if the index isn't ready).
- `ContextCandidate` added to the shared schema (mirrored to TS).

## Frontend

- `lib/context-mentions.ts` (pure, property-tested) — `detectMentionQuery`
  (finds the active `@token` at the caret) and `applyMention` (splices the
  chosen reference in + repositions the caret).
- `lib/agent-client.ts` — `searchContext(sessionId, q, limit)`.
- `lib/store.ts` — `searchContextCandidates(query)` with an offline fallback to
  filtering open files; `addAttachment` kind widened to file/folder/symbol.
- `features/agent/MentionAutocomplete.tsx` — the picker. Owns its keyboard
  handling via a capture-phase listener (↑/↓ navigate, Enter selects, Esc
  closes) so Enter doesn't send the message while the picker is open.
- `features/agent/Composer.tsx` — tracks the caret, computes the active
  mention, renders the picker, and applies the pick.

## Tests

- Backend `tests/test_context_search.py` (5): fuzzy ranking, file/folder
  results, dir queries, empty query, and the endpoint.
- Frontend `lib/__tests__/context-mentions.prop.test.ts` (4): detection,
  non-matches, apply, and a detect→apply round-trip property.

Backend 211 / frontend 124 green; `tsc` + `ruff` clean.

## Generator fix (incidental)

While adding shared models, two latent bugs in
`packages/shared-types/scripts/generate_ts.py` were fixed so the generated
`index.ts` is correct:
- PEP 604 `A | B` unions (e.g. `AgentEvent`) were emitted as `unknown` — now
  handled alongside `typing.Union`.
- multi-value `Literal[...]` discriminators (e.g. lifecycle event `type`) were
  collapsed to `string` — now emitted as proper literal unions, restoring
  discriminated-union narrowing across the frontend.
