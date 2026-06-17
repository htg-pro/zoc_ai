# Project Rules (`.zoc/rules`)

Per-project conventions the agent must follow — Zoc's equivalent of
`.cursorrules` / `AGENTS.md`. A project declares its coding standards,
architectural constraints, and do/don't guidance; Zoc injects them into the
agent's system prompt so output matches the project's conventions.

## Where rules come from (priority order)

1. `.zoc/rules.md` — a single rules file
2. `.zoc/rules/*.md` — multiple rule files (combined, sorted by filename)
3. `AGENTS.md` or `.cursorrules` at the repo root — legacy compatibility, used
   only when no `.zoc` rules exist

The combined content is capped at `MAX_RULES_BYTES` (16 KB) so it can't crowd
out the conversation/tool context.

## How it works

- `agent/project_rules.py` — pure loader: `collect_rule_sources(root)` and
  `load_project_rules(root)` (filesystem-only, never raises).
- `agent/orchestrator.py` — on each run, `load_project_rules(workspace_root)` is
  injected as an additional `system` message right after the workspace context,
  marked authoritative ("follow unless the user explicitly overrides").
- `v1/rules.py` — `GET /v1/sessions/{id}/rules` → `ProjectRulesInfo
  { active, sources, rules }` so the UI can show what's active.

## Frontend

- `lib/agent-client.ts` — `getProjectRules(sessionId)`.
- `lib/store.ts` — `projectRules` state + `loadProjectRules()`, refreshed on
  session select.
- `features/agent/Composer.tsx` — a small **Rules** badge (shield icon) appears
  when rules are active; its tooltip lists the source files.

## Tests

- `tests/test_project_rules.py` (8): none/single/dir/priority/legacy-fallback/
  truncation, plus the endpoint reporting active + inactive states.

Backend 204 / frontend 120 green; `tsc` + `ruff` clean.

## Example

`.zoc/rules.md`:
```md
- Use 2-space indentation in TS, tabs in Go.
- All HTTP handlers must validate input with zod.
- Never import from `legacy/`.
- Prefer composition over inheritance.
```
