#!/usr/bin/env bash
# Freshen everything the Tauri bundle ships, BEFORE Tauri packages it.
#
# This is wired as Tauri's `beforeBuildCommand`, so it runs on EVERY
# `tauri build` no matter how it's invoked (CLI, IDE, `pnpm ... desktop build`).
# Without it, a direct Tauri build would reuse stale `externalBin` binaries in
# `apps/desktop/binaries/` — shipping an old Python sidecar / hotpath even
# though your source changed. That is the classic "I rebuilt but the app's
# functions didn't update" bug.
#
# Steps (all host-native, so it works on Linux / macOS / Windows):
#   1. Build the frontend (Vite production bundle).
#   2. Build + stage the Rust hot-path crate as an externalBin.
#   3. Bundle the FastAPI sidecar (PyInstaller, clean) as an externalBin.
#
# `make release` / scripts/release.sh already does all of this itself, so it
# sets LLAMA_STUDIO_SKIP_PREPARE=1 to make this a no-op and avoid doing the
# (slow) sidecar bundle twice.
set -euo pipefail

if [ "${LLAMA_STUDIO_SKIP_PREPARE:-0}" = "1" ]; then
  echo "==> prepare_tauri_build: LLAMA_STUDIO_SKIP_PREPARE=1 — already prepared by release.sh, skipping."
  exit 0
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> prepare_tauri_build: refreshing externalBins so the bundle ships current code"

# 1. Frontend ---------------------------------------------------------------
echo "==> [1/3] Building frontend"
pnpm --filter @llama-studio/frontend build

# 2. Hot-path crate ---------------------------------------------------------
echo "==> [2/3] Building + staging hotpath crate"
cargo build --release -p llama-studio-hotpath
TRIPLE="${LLAMA_STUDIO_TARGET_TRIPLE:-$(rustc -vV | awk '/^host:/ {print $2}')}"
SUFFIX=""
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) SUFFIX=".exe" ;;
esac
HP_SRC="target/release/llama-studio-hotpath${SUFFIX}"
HP_DST="apps/desktop/binaries/llama-studio-hotpath-${TRIPLE}${SUFFIX}"
if [ ! -f "$HP_SRC" ]; then
  echo "!! Expected hotpath binary at $HP_SRC but it is missing." >&2
  exit 1
fi
mkdir -p apps/desktop/binaries
cp -f "$HP_SRC" "$HP_DST"
chmod +x "$HP_DST" 2>/dev/null || true

# 3. FastAPI sidecar --------------------------------------------------------
echo "==> [3/3] Bundling agent sidecar (clean — guarantees fresh backend code)"
if command -v uv >/dev/null 2>&1; then
  uv run python3 scripts/bundle_sidecar.py
else
  python3 scripts/bundle_sidecar.py
fi

echo "==> prepare_tauri_build: externalBins are current."
