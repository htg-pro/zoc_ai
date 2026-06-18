#!/usr/bin/env bash
# Produce the final release zip at the repo root, containing the cleaned
# source tree plus the built installers from dist/.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ALLOW_EMPTY="${ALLOW_EMPTY_INSTALLERS:-0}"
for arg in "$@"; do
  case "$arg" in
    --allow-empty-installers) ALLOW_EMPTY=1 ;;
    *) echo "!! Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

VERSION="$(cat VERSION | tr -d '[:space:]')"
ZIP="zoc-studio-v${VERSION}.zip"

# Integrity gate: refuse to produce a "release" zip with no installers,
# unless the caller explicitly opts in (e.g. source-only delivery, or a
# CI matrix that zips per-OS and merges later).
INSTALLERS_DIR="$ROOT/dist/installers"
find_release_installers() {
  [ -d "$INSTALLERS_DIR" ] || return 0
  find "$INSTALLERS_DIR" -mindepth 1 -maxdepth 2 \
    \( -type f \( -name '*.tar.gz' -o -name '*.deb' -o -name '*.rpm' \
      -o -name '*.msi' -o -name '*.exe' -o -name '*.dmg' \) \
      -o -type d -name '*.app' \) -print0
}

have_installers=0
while IFS= read -r -d '' _installer; do
  have_installers=1
  break
done < <(find_release_installers)
copy_release_installers() {
  [ -d "$INSTALLERS_DIR" ] || return 0
  mkdir -p "$TOP/dist/installers"
  while IFS= read -r -d '' artifact; do
    rel="${artifact#$INSTALLERS_DIR/}"
    rel_dir="$(dirname "$rel")"
    dest="$TOP/dist/installers"
    if [ "$rel_dir" != "." ]; then
      dest="$dest/$rel_dir"
      mkdir -p "$dest"
    fi
    if [ -d "$artifact" ]; then
      cp -aR "$artifact" "$dest/"
    else
      cp -a "$artifact" "$dest/"
    fi
  done < <(find_release_installers)
}

list_release_installers() {
  [ -d "$INSTALLERS_DIR" ] || return 0
  while IFS= read -r -d '' artifact; do
    printf '  - %s\n' "${artifact#$INSTALLERS_DIR/}"
  done < <(find_release_installers)
}

if [ "$have_installers" = "0" ] && [ -d "$INSTALLERS_DIR" ] && [ -n "$(ls -A "$INSTALLERS_DIR" 2>/dev/null)" ]; then
  echo "!! dist/installers/ exists but contains no recognized installer artifacts." >&2
fi
if [ "$have_installers" = "0" ] && [ "$ALLOW_EMPTY" != "1" ]; then
  cat >&2 <<EOF
!! No installers found in dist/installers/.
!! Run \`bash scripts/release.sh\` first to produce per-OS bundles, or rerun
!! with --allow-empty-installers (or ALLOW_EMPTY_INSTALLERS=1) if you really
!! want a source-only zip (e.g. as part of a multi-host CI merge).
EOF
  exit 1
fi

STAGE="$(mktemp -d)"
TOP="${STAGE}/zoc-studio-v${VERSION}"
mkdir -p "$TOP"

echo "==> Staging release tree at ${TOP}"
if [ "$have_installers" = "1" ]; then
  echo "==> Including installers from dist/installers/"
else
  echo "!! Producing source-only zip (--allow-empty-installers in effect)"
fi

EXCLUDES=(
  --exclude='./.git'
  --exclude='./.github'
  --exclude='./node_modules'
  --exclude='*/node_modules'
  --exclude='./target'
  --exclude='./.venv'
  --exclude='./.pythonlibs'
  --exclude='./.pytest_cache'
  --exclude='*/.pytest_cache'
  --exclude='./.mypy_cache'
  --exclude='*/.mypy_cache'
  --exclude='./.ruff_cache'
  --exclude='*/.ruff_cache'
  --exclude='__pycache__'
  --exclude='*.pyc'
  --exclude='*/dist'
  --exclude='./.vite'
  --exclude='*/.vite'
  --exclude='./.cache'
  --exclude='./.config'
  --exclude='./.local'
  --exclude='./.agents'
  --exclude='./.commandcode'
  --exclude='./.upm'
  --exclude='./legacy'
  --exclude='./zipFile.zip'
  --exclude='./zoc-studio-v*.zip'
  --exclude='*.egg-info'
  --exclude='./dist/sidecar/build'
  --exclude='./dist'
)

# Stage the cleaned source tree.
tar -cf - "${EXCLUDES[@]}" -C "$ROOT" . | tar -xf - -C "$TOP"

# Bring in built artifacts (dist/) explicitly, but skip PyInstaller scratch.
if [ -d "$ROOT/dist" ]; then
  mkdir -p "$TOP/dist"
  tar -cf - --exclude='./sidecar/build' --exclude='./installers' -C "$ROOT/dist" . 2>/dev/null | tar -xf - -C "$TOP/dist"
  copy_release_installers
fi

rm -f "$ROOT/$ZIP"
# Manifest of what we're shipping (handy for CI assertions on the zip).
{
  echo "version: ${VERSION}"
  echo "built: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "host: $(uname -srm 2>/dev/null || echo unknown)"
  if [ "$have_installers" = "1" ]; then
    echo "installers:"
    list_release_installers
  else
    echo "installers: []  # source-only zip (--allow-empty-installers)"
  fi
} > "$TOP/RELEASE_MANIFEST.txt"

if command -v zip >/dev/null 2>&1; then
  (cd "$STAGE" && zip -qr "$ROOT/$ZIP" "zoc-studio-v${VERSION}")
else
  python3 - "$STAGE" "zoc-studio-v${VERSION}" "$ROOT/$ZIP" <<'PY'
import os, sys, zipfile
stage, top, out = sys.argv[1], sys.argv[2], sys.argv[3]
root = os.path.join(stage, top)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dp, _, files in os.walk(root):
        for f in files:
            full = os.path.join(dp, f)
            arc = os.path.relpath(full, stage)
            z.write(full, arc)
PY
fi

rm -rf "$STAGE"

echo "==> Wrote $ZIP ($(du -h "$ROOT/$ZIP" | cut -f1))"
