# Llama Studio

Local-first agentic coding desktop app — llama.cpp-powered, shipped as a
Tauri v2 binary with a bundled FastAPI sidecar.

**Version:** see [`VERSION`](./VERSION) (current: `2.0.0`).

## Architecture

```
llama-studio/
├── apps/
│   ├── desktop/          # Tauri v2 shell (Rust) — owns sidecar + window
│   └── frontend/         # React + Vite + TS + Tailwind + shadcn/ui
├── services/
│   └── agent/            # FastAPI sidecar (Python 3.11+, Pydantic v2)
├── crates/
│   └── hotpath/          # Rust crate: PTY, fs watch, code indexer (+ CLI)
├── packages/
│   └── shared-types/     # Pydantic ↔ TS schema (source of truth)
└── scripts/              # Release pipeline (version, sidecar, zip)
```

### Process model

```
┌────────────────────┐    spawn (Tauri sidecar)     ┌─────────────────────┐
│   Tauri shell      │ ───────────────────────────► │  FastAPI agent      │
│   (apps/desktop)   │                              │  (PyInstaller exe)  │
│                    │ ◄── stdout: PORT=<n> ──────  │  loopback only      │
│                    │                              └──────────┬──────────┘
│                    │   invoke('agent_port') ──► port         │ child CLI
│   React webview    │ ─── HTTP/WS to 127.0.0.1 ──► │          ▼
│   (apps/frontend)  │                              │  hotpath CLI        │
└────────────────────┘                              └─────────────────────┘
```

- Agent binds to **loopback only**; the Tauri shell picks a free port and
  exposes it through the `agent_port` IPC command.
- The hot path is a child CLI, so the sidecar bundle (PyInstaller) stays
  Python-only and trivial to build.

## Quickstart

Prereqs: Node ≥ 20, pnpm ≥ 9, Python ≥ 3.11 (`uv` recommended), Rust stable,
Tauri v2 system deps for your OS
([install](https://tauri.app/start/prerequisites/)).

```bash
# one-time
make install

# full stack: Tauri window → Vite → FastAPI sidecar → hotpath
pnpm dev
```

## Dev loop

```bash
pnpm dev               # full stack via Tauri
pnpm dev:frontend      # frontend only (Vite on :1420)
pnpm dev:agent         # agent only (auto-picked loopback port)
cargo run -p llama-studio-hotpath -- version
```

Quality gates:

```bash
make check    # lint + typecheck + tests across JS / Python / Rust
make lint
make typecheck
make fmt
```

## Build / release

The canonical version lives in [`VERSION`](./VERSION). `scripts/stamp_version.py`
fans it out to every manifest (`package.json`, `Cargo.toml`,
`pyproject.toml`, `tauri.conf.json`).

```bash
make release           # frontend → sidecar → hotpath → Tauri → dist/
make zip               # release + produce llama-studio-v<version>.zip
```

Both the release script and the zip script **fail hard** if installers are
missing — a "release" with no installers is a bug, not a soft warning:

- `scripts/release.sh` exits non-zero if the Tauri CLI is unavailable or if
  the Tauri build produces no installer artifacts in `dist/installers/`.
- `scripts/make_zip.sh` exits non-zero if `dist/installers/` is empty.
- `scripts/verify_zip.py` validates a finished zip: required files present,
  no forbidden paths (`node_modules`, `target`, `legacy`, caches…), and at
  least one installer artifact.

For CI matrices that produce per-OS installers separately and merge later,
use the explicit source-only flow:

```bash
make release-source-only   # bash scripts/release.sh --source-only
make zip-source-only       # also runs verify_zip.py --source-only
```

What `make release` does, step by step:

1. `python3 scripts/stamp_version.py` — stamp `VERSION` everywhere.
2. `pnpm --filter @llama-studio/frontend build` — Vite production bundle.
3. `cargo build --release -p llama-studio-hotpath` — Rust hot-path crate.
4. `python3 scripts/bundle_sidecar.py` — PyInstaller `--onefile` build of the
   FastAPI agent, copied to
   `apps/desktop/binaries/llama-studio-agent-<rust-target-triple>` so Tauri's
   `externalBin` picks it up.
5. `pnpm --filter @llama-studio/desktop build` — Tauri bundler. Both
   `llama-studio-agent` (PyInstaller) and `llama-studio-hotpath` (Rust) are
   registered as `externalBin` in `tauri.conf.json`, so the installer ships
   the hotpath binary next to the main executable. At runtime the Tauri shell
   resolves it via `current_exe()` and exports `LLAMA_STUDIO_HOTPATH_BIN` to
   the agent sidecar — no reliance on `PATH` or a developer's `target/` dir.
   Outputs land under `target/release/bundle/`; the script collects all
   installer file types **and** macOS `.app` bundles (directories) into
   `dist/installers/`.

### Bundle targets per OS

`tauri.conf.json` requests `["deb", "rpm", "msi", "nsis", "dmg", "app"]`.
On Linux, `scripts/release.sh` additionally produces a portable `.tar.gz`
on top of Tauri's `.deb` and `.rpm` outputs. What you actually get depends
on the host you build from:

| Host                | Produced                                  | Missing → build on       |
|---------------------|-------------------------------------------|--------------------------|
| Linux (x86_64)      | `.deb`, `.rpm`, `.tar.gz`                 | macOS, Windows           |
| macOS               | `.dmg`, `.app`                            | Linux, Windows           |
| Windows             | `.msi`, `.exe` (NSIS)                     | Linux, macOS             |

To produce all installers you must run `make release` on each host (or a CI
matrix). Cross-compiling Tauri bundles between OSes is not supported.

### CI release matrix

[`.github/workflows/release.yml`](./.github/workflows/release.yml) runs the
release pipeline on `ubuntu-latest`, `macos-latest`, and `windows-latest` in
parallel. Each job installs Node + pnpm, Python (with PyInstaller via uv),
Rust, the Tauri CLI, and the platform's Tauri system deps, then runs
`bash scripts/release.sh`. The per-OS contents of `dist/installers/` are
uploaded as workflow artifacts (`installers-linux`, `installers-macos`,
`installers-windows`).

A follow-up `package` job downloads every per-OS `dist/` tree, merges them
into a single `dist/installers/`, and runs `bash scripts/make_zip.sh` (plus
`scripts/verify_zip.py`) to publish the combined `llama-studio-v<version>.zip`.

Triggers:

- `workflow_dispatch` — build all three OSes, artifacts only.
- Pull requests that touch the release plumbing — smoke the matrix without
  publishing.
- Tag push matching `v*` — the `release` job creates a GitHub Release for
  that tag and attaches every per-OS installer plus the combined zip
  (macOS `.app` bundles are zipped before upload).

### Code signing & notarization

Out of scope for the default build. To enable:

- **macOS**: set `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`,
  `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`,
  then re-run `make release`. Tauri will sign and notarize automatically.
- **Windows**: configure `tauri.bundle.windows.certificateThumbprint` (or
  set `WINDOWS_CERTIFICATE` / `WINDOWS_CERTIFICATE_PASSWORD`).
- **Linux**: no signing required; sign the `.tar.gz` out-of-band with
  `gpg --detach-sign` (or rely on the GitHub Release page checksums).

### Auto-update

The Tauri updater is **disabled by default**. To enable, in
`tauri.conf.json`:

```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": ["https://releases.llama.studio/updates/{{target}}/{{arch}}/{{current_version}}"],
    "pubkey": "<your minisign pubkey>"
  }
}
```

and host signed update manifests at that endpoint. See
[Tauri updater docs](https://v2.tauri.app/plugin/updater/).

## Troubleshooting

- **`tauri: command not found`** — install the Tauri CLI:
  `pnpm --filter @llama-studio/desktop add -D @tauri-apps/cli`.
- **Sidecar bundling fails** — install PyInstaller:
  `uv pip install pyinstaller`. Re-run `make sidecar`.
- **Webview missing on Linux** — install `webkit2gtk-4.1`, `libsoup-3.0`,
  and platform Tauri prerequisites.
- **Frontend can't reach agent** — check the workflow logs; the agent prints
  `LLAMA_STUDIO_AGENT_PORT=<n>` on startup. The Tauri shell only forwards
  loopback URLs.
- **Schema drift CI failure** — edit Pydantic models, run
  `pnpm schema:generate`, commit both Python and TS sides.

## Conventions

- **Loopback only.** Never bind the agent to a public interface.
- **Schema drift is a CI failure.** Pydantic is the source of truth.
- **No silent fallbacks.** If a piece can't start, fail loudly with a clear
  error.

See [`CHANGELOG.md`](./CHANGELOG.md) for release history.

glpat-U452Q5ioK1gbxZ0iHRhr_2M6MQpvOjEKdTpuOTlweg8.01.171w20x6s