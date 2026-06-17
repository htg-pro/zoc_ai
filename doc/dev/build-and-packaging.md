# Build & Packaging — and the "stale build" fix

## What ships in the desktop app

The Tauri bundle is the Rust shell **plus three prebuilt artifacts**:

| Artifact | Produced by | Where it lands |
|----------|-------------|----------------|
| Frontend (`dist/`) | `pnpm --filter @llama-studio/frontend build` | `apps/frontend/dist` (`frontendDist`) |
| Hot-path CLI | `cargo build --release -p llama-studio-hotpath` | `apps/desktop/binaries/llama-studio-hotpath-<triple>` (`externalBin`) |
| FastAPI **sidecar** | `scripts/bundle_sidecar.py` (PyInstaller) | `apps/desktop/binaries/llama-studio-agent-<triple>` (`externalBin`) |

Most application logic lives in the **Python sidecar**. The Rust shell spawns
it via Tauri's `shell().sidecar("llama-studio-agent")`, which resolves the
bundled `externalBin` next to the executable — there is no fallback to a repo
`target/` path in an installed build.

## The bug this fixes

Previously, `beforeBuildCommand` only rebuilt the **frontend**. The sidecar and
hotpath `externalBin`s were whatever stale binaries happened to be sitting in
`apps/desktop/binaries/`. So a direct `tauri build` (or an IDE build, or
`pnpm --filter @llama-studio/desktop build`) would package an **old Python
backend** even though you'd changed the source — the classic "I rebuilt but the
app's functions didn't update" symptom, on every platform.

## The fix

`beforeBuildCommand` now runs `scripts/prepare_tauri_build.sh` (via
`pnpm -w run tauri:prepare`), which on **every** `tauri build`:

1. Builds the frontend.
2. Builds + stages the hotpath crate as an `externalBin`.
3. Bundles the sidecar with PyInstaller `--clean` (guaranteed-fresh backend).

Because it's wired into `beforeBuildCommand`, it runs no matter how Tauri is
invoked, on Linux / macOS / Windows.

`scripts/bundle_sidecar.py` already cleans its PyInstaller cache by default
(`work/`, `dist/`, `.spec`, and `--clean`), so no stale analysis survives.

### Avoiding double work in `make release`

`scripts/release.sh` already builds the frontend, hotpath, and sidecar itself
before invoking Tauri. To avoid bundling the (slow) sidecar twice, it runs the
Tauri build with `LLAMA_STUDIO_SKIP_PREPARE=1`, which makes
`prepare_tauri_build.sh` a no-op. Use the same flag if you've just bundled the
sidecar yourself and want a faster Tauri build.

## Cross-platform installers

`tauri.conf.json` sets `bundle.targets: "all"`, so each host produces its
native installers:

| Host | Installers |
|------|------------|
| Linux | `.deb`, `.rpm` (+ `.tar.gz` from `release.sh`) |
| macOS | `.dmg`, `.app` |
| Windows | `.msi`, `.exe` (NSIS) |

Cross-compiling installers between OSes is **not** supported — build each OS on
its own host or CI runner (see the release matrix in the top-level `README.md`).

## Quick commands

```bash
# Full release (stamps version, builds everything, bundles installers)
make release

# Just refresh the bundled binaries (what beforeBuildCommand runs)
pnpm -w run tauri:prepare

# Direct Tauri build — now always ships fresh code
pnpm --filter @llama-studio/desktop build
```
