#!/bin/sh
# Bootstrap script: links required packages from the pnpm store into
# apps/frontend/node_modules so vite can start without a full pnpm install.

set -e

PNPM="node_modules/.pnpm"
FE="apps/frontend/node_modules"
NODE="/nix/store/1lagpgadaybvs1n2312gysg2phjk89y8-nodejs-20.20.0-wrapped/bin/node"
VITE_JS="$PNPM/vite@5.4.21_@types+node@22.19.19/node_modules/vite/bin/vite.js"

mkdir -p "$FE/.bin" "$FE/@vitejs" "$FE/@radix-ui" "$FE/@types" \
         "$FE/@tauri-apps" "$FE/@xterm" "$FE/@zoc-studio" "$FE/@monaco-editor"

link() {
  src="$1"; dst="$2"
  if [ -d "$src" ] || [ -f "$src" ]; then
    ln -sfn "$(pwd)/$src" "$dst"
  fi
}

# ── Core build tools ────────────────────────────────────────────────────────
link "$PNPM/vite@5.4.21_@types+node@22.19.19/node_modules/vite"                          "$FE/vite"
link "$PNPM/@vitejs+plugin-react@4.7.0_vite@5.4.21_@types+node@22.19.19_/node_modules/@vitejs/plugin-react" "$FE/@vitejs/plugin-react"
link "$PNPM/tailwindcss@3.4.19/node_modules/tailwindcss"                                  "$FE/tailwindcss"
link "$PNPM/postcss@8.5.15/node_modules/postcss"                                          "$FE/postcss"
link "$PNPM/autoprefixer@10.5.0_postcss@8.5.15/node_modules/autoprefixer"                 "$FE/autoprefixer"
link "$PNPM/tailwindcss-animate@1.0.7_tailwindcss@3.4.19/node_modules/tailwindcss-animate" "$FE/tailwindcss-animate"
link "$PNPM/typescript@5.9.3/node_modules/typescript"                                     "$FE/typescript"

# ── React ───────────────────────────────────────────────────────────────────
link "$PNPM/react@18.3.1/node_modules/react"                                              "$FE/react"
link "$PNPM/react-dom@18.3.1_react@18.3.1/node_modules/react-dom"                        "$FE/react-dom"
link "$PNPM/react-refresh@0.17.0/node_modules/react-refresh"                             "$FE/react-refresh"

# ── UI libraries ────────────────────────────────────────────────────────────
link "$PNPM/lucide-react@0.453.0_react@18.3.1/node_modules/lucide-react"                 "$FE/lucide-react"
link "$PNPM/class-variance-authority@0.7.1/node_modules/class-variance-authority"        "$FE/class-variance-authority"
link "$PNPM/clsx@2.1.1/node_modules/clsx"                                                "$FE/clsx"
link "$PNPM/tailwind-merge@2.6.1/node_modules/tailwind-merge"                            "$FE/tailwind-merge"
link "$PNPM/diff@9.0.0/node_modules/diff"                                                "$FE/diff"
link "$PNPM/fuse.js@7.3.0/node_modules/fuse.js"                                          "$FE/fuse.js"
link "$PNPM/zustand@5.0.14_@types+react@18.3.29_react@18.3.1/node_modules/zustand"       "$FE/zustand"
link "$PNPM/cmdk@1.1.1_@types+react-dom@18.3.7_@types+react@18.3.29__@types+react@18.3.29_react-dom_2cf4484ccbaf6c475eede2018fdbe564/node_modules/cmdk" "$FE/cmdk"
link "$PNPM/monaco-editor@0.55.1/node_modules/monaco-editor"                             "$FE/monaco-editor"

# sonner
SONNER=$(ls "$PNPM" | grep "^sonner@" | head -1)
[ -n "$SONNER" ] && link "$PNPM/$SONNER/node_modules/sonner" "$FE/sonner"

# react-resizable-panels
RRP=$(ls "$PNPM" | grep "^react-resizable-panels@" | head -1)
[ -n "$RRP" ] && link "$PNPM/$RRP/node_modules/react-resizable-panels" "$FE/react-resizable-panels"

# @monaco-editor/react
MREACT=$(ls "$PNPM" | grep "^@monaco-editor+react@" | head -1)
[ -n "$MREACT" ] && link "$PNPM/$MREACT/node_modules/@monaco-editor/react" "$FE/@monaco-editor/react"

# ── @zoc-studio/shared-types (workspace package) ────────────────────────────
[ -d "packages/shared-types" ] && ln -sfn "$(pwd)/packages/shared-types" "$FE/@zoc-studio/shared-types"

# ── @types ─────────────────────────────────────────────────────────────────
ANODE=$(ls "$PNPM" | grep "^@types+node@" | head -1)
AREACT=$(ls "$PNPM" | grep "^@types+react@" | head -1)
AREACTDOM=$(ls "$PNPM" | grep "^@types+react-dom@" | head -1)
[ -n "$ANODE" ]     && link "$PNPM/$ANODE/node_modules/@types/node"      "$FE/@types/node"
[ -n "$AREACT" ]    && link "$PNPM/$AREACT/node_modules/@types/react"    "$FE/@types/react"
[ -n "$AREACTDOM" ] && link "$PNPM/$AREACTDOM/node_modules/@types/react-dom" "$FE/@types/react-dom"

# ── @xterm ──────────────────────────────────────────────────────────────────
XTERM=$(ls "$PNPM" | grep "^@xterm+xterm@" | head -1)
XTERMFIT=$(ls "$PNPM" | grep "^@xterm+addon-fit@" | head -1)
[ -n "$XTERM" ]    && link "$PNPM/$XTERM/node_modules/@xterm/xterm"        "$FE/@xterm/xterm"
[ -n "$XTERMFIT" ] && link "$PNPM/$XTERMFIT/node_modules/@xterm/addon-fit" "$FE/@xterm/addon-fit"

# ── @radix-ui packages ───────────────────────────────────────────────────────
for radix_dir in $(ls "$PNPM" | grep "^@radix-ui+"); do
  pkg_name=$(echo "$radix_dir" | sed 's/^@radix-ui+//' | sed 's/@.*//' | sed 's/+/-/g')
  link "$PNPM/$radix_dir/node_modules/@radix-ui/$pkg_name" "$FE/@radix-ui/$pkg_name"
done

# ── @tauri-apps packages ─────────────────────────────────────────────────────
for tauri_dir in $(ls "$PNPM" | grep "^@tauri-apps+"); do
  pkg_name=$(echo "$tauri_dir" | sed 's/^@tauri-apps+//' | sed 's/@.*//' | sed 's/+/-/g')
  link "$PNPM/$tauri_dir/node_modules/@tauri-apps/$pkg_name" "$FE/@tauri-apps/$pkg_name"
done

# ── vite bin wrapper ────────────────────────────────────────────────────────
cat > "$FE/.bin/vite" << VITEEOF
#!/bin/sh
exec $NODE $(pwd)/$VITE_JS "\$@"
VITEEOF
chmod +x "$FE/.bin/vite"

echo "✓ Frontend node_modules bootstrapped"
echo "Starting vite dev server on :5000..."
cd apps/frontend && "$NODE" "../../$VITE_JS" --port 5000 --host 0.0.0.0
