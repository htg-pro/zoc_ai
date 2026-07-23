#!/bin/sh
# Bootstrap script for Replit development.
#
# 1. Starts the Zoc AI backend server (Node.js, port 3001).
# 2. Ensures apps/frontend/node_modules has proper symlinks to pnpm store pkgs.
# 3. Starts the Vite dev server on port 5000.

set -e

NODE="/nix/store/1lagpgadaybvs1n2312gysg2phjk89y8-nodejs-20.20.0-wrapped/bin/node"
PNPM="node_modules/.pnpm"

# ── Helper: (re-)create a symlink, removing any existing dir/file first ────────
forcelink() {
  src="$(pwd)/$1"
  dst="$2"
  if [ -d "$src" ] || [ -f "$src" ]; then
    rm -rf "$dst"
    ln -sfn "$src" "$dst"
  fi
}

# ── Locate vite.js in the pnpm store ─────────────────────────────────────────
VITE_PKG=""
if [ -d "$PNPM" ]; then
  VITE_PKG=$(ls "$PNPM" 2>/dev/null | grep "^vite@6\." | head -1)
fi

if [ -n "$VITE_PKG" ]; then
  VITE_JS="$PNPM/$VITE_PKG/node_modules/vite/bin/vite.js"
  [ ! -f "$VITE_JS" ] && VITE_JS=""
fi

if [ -z "$VITE_JS" ] && [ -f "apps/frontend/node_modules/vite/bin/vite.js" ]; then
  VITE_JS="apps/frontend/node_modules/vite/bin/vite.js"
fi

if [ -z "$VITE_JS" ]; then
  echo "ERROR: vite not found. Run: pnpm install" >&2
  exit 1
fi

echo "✓ Using vite: $VITE_JS"

# ── Fix / create symlinks in apps/frontend/node_modules ──────────────────────
FE="apps/frontend/node_modules"
mkdir -p "$FE/.bin" "$FE/@vitejs" "$FE/@radix-ui" "$FE/@types" \
         "$FE/@tauri-apps" "$FE/@xterm" "$FE/@zoc-studio" "$FE/@monaco-editor" \
         "$FE/@codingame"

if [ -d "$PNPM" ]; then
  # ── vite (critical: pnpm may create as a directory; force symlink) ──────────
  forcelink "$PNPM/$VITE_PKG/node_modules/vite" "$FE/vite"

  # ── @vitejs/plugin-react ────────────────────────────────────────────────────
  VR=$(ls "$PNPM" 2>/dev/null | grep "^@vitejs+plugin-react@4\." | grep "_vite@6\." | head -1)
  [ -n "$VR" ] && forcelink "$PNPM/$VR/node_modules/@vitejs/plugin-react" "$FE/@vitejs/plugin-react"

  # ── Core packages (force symlink in case pnpm made them dirs) ───────────────
  for name in tailwindcss postcss autoprefixer; do
    dir=$(ls "$PNPM" 2>/dev/null | grep "^${name}@" | head -1)
    [ -n "$dir" ] && forcelink "$PNPM/$dir/node_modules/$name" "$FE/$name"
  done

  TA=$(ls "$PNPM" 2>/dev/null | grep "^tailwindcss-animate@" | head -1)
  [ -n "$TA" ] && forcelink "$PNPM/$TA/node_modules/tailwindcss-animate" "$FE/tailwindcss-animate"

  TS=$(ls "$PNPM" 2>/dev/null | grep "^typescript@5" | head -1)
  [ -n "$TS" ] && forcelink "$PNPM/$TS/node_modules/typescript" "$FE/typescript"

  # ── React ───────────────────────────────────────────────────────────────────
  R=$(ls "$PNPM" 2>/dev/null | grep "^react@18\." | head -1)
  [ -n "$R" ] && forcelink "$PNPM/$R/node_modules/react" "$FE/react"

  RD=$(ls "$PNPM" 2>/dev/null | grep "^react-dom@18\." | head -1)
  [ -n "$RD" ] && forcelink "$PNPM/$RD/node_modules/react-dom" "$FE/react-dom"

  RR=$(ls "$PNPM" 2>/dev/null | grep "^react-refresh@" | head -1)
  [ -n "$RR" ] && forcelink "$PNPM/$RR/node_modules/react-refresh" "$FE/react-refresh"

  # ── UI libs ─────────────────────────────────────────────────────────────────
  for pkg in lucide-react class-variance-authority clsx tailwind-merge diff fuse.js; do
    dir=$(ls "$PNPM" 2>/dev/null | grep "^${pkg}@" | head -1)
    [ -n "$dir" ] && forcelink "$PNPM/$dir/node_modules/$pkg" "$FE/$pkg"
  done

  ZU=$(ls "$PNPM" 2>/dev/null | grep "^zustand@" | head -1)
  [ -n "$ZU" ] && forcelink "$PNPM/$ZU/node_modules/zustand" "$FE/zustand"

  CM=$(ls "$PNPM" 2>/dev/null | grep "^cmdk@" | head -1)
  [ -n "$CM" ] && forcelink "$PNPM/$CM/node_modules/cmdk" "$FE/cmdk"

  SONNER=$(ls "$PNPM" 2>/dev/null | grep "^sonner@" | head -1)
  [ -n "$SONNER" ] && forcelink "$PNPM/$SONNER/node_modules/sonner" "$FE/sonner"

  RRP=$(ls "$PNPM" 2>/dev/null | grep "^react-resizable-panels@" | head -1)
  [ -n "$RRP" ] && forcelink "$PNPM/$RRP/node_modules/react-resizable-panels" "$FE/react-resizable-panels"

  # ── Monaco ───────────────────────────────────────────────────────────────────
  MVAPI=$(ls "$PNPM" 2>/dev/null | grep "^@codingame+monaco-vscode-api@" | head -1)
  MEAPI=$(ls "$PNPM" 2>/dev/null | grep "^@codingame+monaco-vscode-editor-api@" | head -1)
  MLC=$(ls "$PNPM" 2>/dev/null | grep "^monaco-languageclient@" | head -1)
  VSRPC=$(ls "$PNPM" 2>/dev/null | grep "^vscode-ws-jsonrpc@" | head -1)
  MREACT=$(ls "$PNPM" 2>/dev/null | grep "^@monaco-editor+react@" | head -1)

  [ -n "$MVAPI" ]  && forcelink "$PNPM/$MVAPI/node_modules/@codingame/monaco-vscode-api"    "$FE/@codingame/monaco-vscode-api"
  [ -n "$MEAPI" ]  && forcelink "$PNPM/$MEAPI/node_modules/@codingame/monaco-vscode-editor-api" "$FE/monaco-editor"
  [ -n "$MLC" ]    && forcelink "$PNPM/$MLC/node_modules/monaco-languageclient"              "$FE/monaco-languageclient"
  [ -n "$VSRPC" ]  && forcelink "$PNPM/$VSRPC/node_modules/vscode-ws-jsonrpc"                "$FE/vscode-ws-jsonrpc"
  [ -n "$MREACT" ] && forcelink "$PNPM/$MREACT/node_modules/@monaco-editor/react"            "$FE/@monaco-editor/react"

  # ── Shared types ─────────────────────────────────────────────────────────────
  [ -d "packages/shared-types" ] && rm -rf "$FE/@zoc-studio/shared-types" && \
    ln -sfn "$(pwd)/packages/shared-types" "$FE/@zoc-studio/shared-types"

  # ── @types ───────────────────────────────────────────────────────────────────
  AN=$(ls "$PNPM" 2>/dev/null | grep "^@types+node@" | head -1)
  AR=$(ls "$PNPM" 2>/dev/null | grep "^@types+react@" | head -1)
  AD=$(ls "$PNPM" 2>/dev/null | grep "^@types+react-dom@" | head -1)
  [ -n "$AN" ] && forcelink "$PNPM/$AN/node_modules/@types/node"      "$FE/@types/node"
  [ -n "$AR" ] && forcelink "$PNPM/$AR/node_modules/@types/react"     "$FE/@types/react"
  [ -n "$AD" ] && forcelink "$PNPM/$AD/node_modules/@types/react-dom" "$FE/@types/react-dom"

  # ── @xterm ───────────────────────────────────────────────────────────────────
  XT=$(ls "$PNPM" 2>/dev/null | grep "^@xterm+xterm@" | head -1)
  XF=$(ls "$PNPM" 2>/dev/null | grep "^@xterm+addon-fit@" | head -1)
  [ -n "$XT" ] && forcelink "$PNPM/$XT/node_modules/@xterm/xterm"        "$FE/@xterm/xterm"
  [ -n "$XF" ] && forcelink "$PNPM/$XF/node_modules/@xterm/addon-fit"    "$FE/@xterm/addon-fit"

  # ── @radix-ui ────────────────────────────────────────────────────────────────
  for d in $(ls "$PNPM" 2>/dev/null | grep "^@radix-ui+"); do
    n=$(echo "$d" | sed 's/^@radix-ui+//' | sed 's/@.*//' | sed 's/+/-/g')
    forcelink "$PNPM/$d/node_modules/@radix-ui/$n" "$FE/@radix-ui/$n"
  done

  # ── @tauri-apps ───────────────────────────────────────────────────────────────
  for d in $(ls "$PNPM" 2>/dev/null | grep "^@tauri-apps+"); do
    n=$(echo "$d" | sed 's/^@tauri-apps+//' | sed 's/@.*//' | sed 's/+/-/g')
    forcelink "$PNPM/$d/node_modules/@tauri-apps/$n" "$FE/@tauri-apps/$n"
  done
fi

echo "✓ Frontend node_modules ready"

# ── Start the Zoc AI backend server ──────────────────────────────────────────
echo "Starting Zoc AI backend on :3001 ..."
"$NODE" "$(pwd)/server/index.js" &

# Wait for backend (max 5 s)
for i in 1 2 3 4 5; do
  sleep 1
  if "$NODE" -e "
    const http = require('http');
    const req = http.get('http://127.0.0.1:3001/health', r => process.exit(r.statusCode===200?0:1));
    req.on('error', () => process.exit(1));
  " 2>/dev/null; then
    echo "✓ Backend ready"
    break
  fi
done

# ── Start Vite dev server ─────────────────────────────────────────────────────
echo "Starting Vite dev server on :5000 ..."
cd apps/frontend
exec "$NODE" "../../$VITE_JS" --port 5000 --host 0.0.0.0
