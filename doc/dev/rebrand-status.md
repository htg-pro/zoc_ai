# Rebrand to Zoc AI — Status & Plan

## ✅ Done (this pass) — user-facing branding

Every **display** occurrence of "Llama Studio" → **"Zoc AI"** across all 41
files that contained it (README, docs, `CHANGELOG`, `tauri.conf.json`
`productName` + window title, `package.json`/`pyproject.toml` descriptions, UI
strings in `TopBar`, `OnboardingWizard`, `Appearance`, `ShowcaseView`,
`mock-data`, the agent system prompt, etc.).

This is safe because "Llama Studio" (with a space) is **only ever display
text** — it never appears in a code identifier. Verified: **197 backend + 122
frontend tests pass**, configs still valid JSON.

The app now *presents* as "Zoc AI" everywhere a user sees it. The internal
package/binary names below are intentionally unchanged for now (a product's
display name commonly differs from its package id).

## ⚠️ Not done yet — machine identifiers (build-critical)

These are **not branding strings** — they're identifiers the build and runtime
depend on. A blind find/replace would break the build on every platform, and
the break would not surface until a full `tauri build` (which can't be run in
this environment). They must be renamed as **one atomic, verified pass**:

| Current | Proposed | Referenced by (must change together) |
|---------|----------|--------------------------------------|
| Python pkg `llama_studio_agent` (dir + ~162 refs) | `zoc_agent` | all `src`/`tests` imports, `pyproject.toml` packaging, `bundle_sidecar.py` (`--name`, `--paths`, `--collect-submodules`), `scripts/launch.py`, entry points |
| npm scope `@llama-studio/*` | `@zoc/*` | every `pnpm --filter` in `package.json`, `Makefile`, `release.sh`, `tauri.conf.json` `beforeDev/BuildCommand`, each workspace `package.json` |
| cargo crates `llama-studio`, `llama-studio-hotpath` | `zoc`, `zoc-hotpath` | `Cargo.toml` workspace + crate manifests, `cargo build -p` invocations |
| binaries `llama-studio-agent`, `llama-studio-hotpath` | `zoc-agent`, `zoc-hotpath` | `tauri.conf.json` `externalBin`, `apps/desktop/src/sidecar.rs` `shell().sidecar("…")`, `bundle_sidecar.py` output name, `release.sh`/`prepare_tauri_build.sh` staging paths |
| env vars `LLAMA_STUDIO_*` | `ZOC_*` | Rust shell, Python settings, scripts (`LLAMA_STUDIO_AGENT_PORT` handshake, `LLAMA_STUDIO_SKIP_PREPARE`, `LLAMA_STUDIO_TARGET_TRIPLE`, …) |
| Tauri `identifier` `ai.llama.studio` | `ai.zoc.studio` | changes the OS app-data dir + keychain namespace (a deliberate, one-time decision) |

**How to do it safely (recommended):** one PR, change all references for a
single identifier at a time, running `cargo check`, `pytest`, `vitest`, and
`tsc` after each — these catch most misses. The only piece not verifiable
without a real bundle is the Tauri `externalBin` ↔ `sidecar.rs` spawn-name
match, so grep those two must agree exactly.

## ⚠️ `Replit*` naming — rename or delete?

`ReplitPlan` / `ReplitTask` / `replit_workflow` / the `replit/*` routes
(~830 occurrences) are the **legacy planning subsystem already slated for
deletion** in [`agent-collapse-plan.md`](./agent-collapse-plan.md). Renaming
them to `Zoc*` and then deleting them later is wasted work.

**Recommendation:** do not rename Replit*. Execute the collapse plan (delete it)
instead — that removes the name entirely, which is the actual goal. If the
subsystem must live on, rename it as part of the atomic pass above.

## Why this split

Per the project's own conventions ("no silent fallbacks", don't break the
build), the visible rebrand is shipped and verified now, while the identifier
rename — which is hard to verify here and easy to get subtly wrong — is staged
as a deliberate, test-gated migration rather than a risky blind sweep.
