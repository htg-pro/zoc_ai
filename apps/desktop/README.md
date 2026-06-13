# `@llama-studio/desktop`

Tauri v2 shell. Loads the Vite dev server (`apps/frontend`) in dev and the
built frontend in prod. On launch it spawns the FastAPI agent sidecar via the
shell plugin, reads `LLAMA_STUDIO_AGENT_PORT=<n>` from stdout, and exposes the
port to the frontend via the `agent_port` Tauri command.

## Sidecar binary

`tauri.conf.json` declares `binaries/llama-studio-agent` as an external bin.
The packaging phase (Phase 5) is responsible for producing a PyInstaller (or
equivalent) single-file build of `services/agent` and placing it at
`apps/desktop/binaries/llama-studio-agent-<triple>`. During dev the same
sidecar can be run manually via `pnpm dev:agent`.
