#!/bin/sh
# Install the Monaco LSP language-server binaries from a single
# source-of-truth table that maps each Server_Binary to the command that
# installs it:
#
#   pyright-langserver         -> uv pip install pyright
#   typescript-language-server -> npm install -g typescript-language-server typescript
#   rust-analyzer              -> rustup component add rust-analyzer
#                                 (or the downloaded prebuilt release binary)
#
# The table below is the one place these mappings live; the install logic and
# the failure summary both derive from it, and `make doctor` reports the same
# commands. A Server_Binary is therefore only ever handled or reported when its
# install command is known (Requirement 8.6).

set -e

# ── Source of truth: "Server_Binary|install command", one row per server ─────
# `make doctor` prints the identical install command when a binary is missing,
# so the two never drift.
lsp_server_table() {
  cat <<'TABLE'
pyright-langserver|uv pip install pyright
typescript-language-server|npm install -g typescript-language-server typescript
rust-analyzer|rustup component add rust-analyzer
TABLE
}

# The Server_Binary names, in table order.
lsp_server_binaries() {
  lsp_server_table | cut -d'|' -f1
}

# Print the install command for a Server_Binary; exit non-zero when the binary
# is absent from the table (its install command is unknown, so it is not
# handled — Requirement 8.6).
lsp_install_command() {
  lsp_server_table | awk -F'|' -v want="$1" '
    $1 == want { sub(/^[^|]*\|/, ""); print; found = 1 }
    END { exit !found }
  '
}

# ── Install helpers ──────────────────────────────────────────────────────────

# True when a binary is already resolvable on PATH.
lsp_have() {
  command -v "$1" >/dev/null 2>&1
}

# Directory for downloaded binaries (rust-analyzer prebuilt fallback): prefer an
# existing cargo bin dir, else ~/.local/bin.
lsp_bin_dir() {
  if [ -n "${CARGO_HOME:-}" ] && [ -d "$CARGO_HOME/bin" ]; then
    printf '%s\n' "$CARGO_HOME/bin"
  elif [ -d "$HOME/.cargo/bin" ]; then
    printf '%s\n' "$HOME/.cargo/bin"
  else
    printf '%s\n' "$HOME/.local/bin"
  fi
}

# Run a table install command. The base tool (first word, e.g. uv/npm) must be
# on PATH; if it is not, report it and the exact command instead of failing hard.
lsp_run_install() {
  _binary="$1"
  _cmd="$2"
  _tool=${_cmd%% *}
  if ! lsp_have "$_tool"; then
    echo "!! Skipping $_binary: required tool '$_tool' is not on PATH" >&2
    echo "   Install '$_tool', then run: $_cmd" >&2
    return 1
  fi
  echo "==> $_cmd"
  # Deliberate word-splitting: table commands are simple, unquoted tokens.
  # shellcheck disable=SC2086
  $_cmd
}

# The rust-analyzer release triple for the current platform, or non-zero if
# there is no prebuilt binary for it.
lsp_rust_analyzer_triple() {
  _os=$(uname -s)
  _arch=$(uname -m)
  case "$_os" in
    Linux)
      case "$_arch" in
        x86_64 | amd64) echo "x86_64-unknown-linux-gnu" ;;
        aarch64 | arm64) echo "aarch64-unknown-linux-gnu" ;;
        *) return 1 ;;
      esac
      ;;
    Darwin)
      case "$_arch" in
        x86_64 | amd64) echo "x86_64-apple-darwin" ;;
        aarch64 | arm64) echo "aarch64-apple-darwin" ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

# Download the prebuilt rust-analyzer release binary (gunzip + chmod +x) into a
# PATH directory — the "downloaded binary" arm of Requirement 8.1.
lsp_download_rust_analyzer() {
  _triple=$(lsp_rust_analyzer_triple) || {
    echo "!! No prebuilt rust-analyzer for $(uname -s) $(uname -m); install it via rustup" >&2
    return 1
  }
  _dir=$(lsp_bin_dir)
  _url="https://github.com/rust-lang/rust-analyzer/releases/latest/download/rust-analyzer-${_triple}.gz"
  _tmp=$(mktemp -d)
  echo "==> Downloading rust-analyzer ($_triple)"
  if lsp_have curl; then
    curl -fsSL "$_url" -o "$_tmp/rust-analyzer.gz"
  elif lsp_have wget; then
    wget -qO "$_tmp/rust-analyzer.gz" "$_url"
  else
    echo "!! Need curl or wget to download rust-analyzer" >&2
    rm -rf "$_tmp"
    return 1
  fi
  gunzip "$_tmp/rust-analyzer.gz"
  chmod +x "$_tmp/rust-analyzer"
  mkdir -p "$_dir"
  mv "$_tmp/rust-analyzer" "$_dir/rust-analyzer"
  rm -rf "$_tmp"
  echo "✓ Installed rust-analyzer to $_dir/rust-analyzer"
  case ":$PATH:" in
    *":$_dir:"*) ;;
    *) echo "!! $_dir is not on PATH; add it so rust-analyzer is found" >&2 ;;
  esac
}

# rust-analyzer: prefer `rustup component add`, else fall back to the prebuilt
# release binary (Requirement 8.1: "cargo/rustup or a downloaded binary").
lsp_install_rust_analyzer() {
  if lsp_have rustup; then
    echo "==> rustup component add rust-analyzer"
    if rustup component add rust-analyzer >/dev/null 2>&1 && lsp_have rust-analyzer; then
      echo "✓ Installed rust-analyzer via rustup"
      return 0
    fi
    echo "!! rustup did not expose rust-analyzer on PATH; downloading prebuilt binary" >&2
  fi
  lsp_download_rust_analyzer
}

# Install a single Server_Binary if it is not already present. Only binaries in
# the table (whose install command is known) are handled (Requirement 8.6).
lsp_install_one() {
  _binary="$1"
  _cmd=$(lsp_install_command "$_binary") || {
    echo "!! No known install command for '$_binary'; skipping" >&2
    return 1
  }
  if lsp_have "$_binary"; then
    echo "✓ $_binary already installed ($(command -v "$_binary"))"
    return 0
  fi
  case "$_binary" in
    rust-analyzer) lsp_install_rust_analyzer ;;
    *) lsp_run_install "$_binary" "$_cmd" ;;
  esac
}

# ── Install every language server in the table ───────────────────────────────
main() {
  echo "==> Installing Monaco LSP language servers"
  _failed=""
  for _binary in $(lsp_server_binaries); do
    if ! lsp_install_one "$_binary"; then
      _failed="$_failed $_binary"
    fi
  done
  echo ""
  if [ -n "$_failed" ]; then
    echo "!! Some language servers were not installed:" >&2
    for _binary in $_failed; do
      echo "   - $_binary : $(lsp_install_command "$_binary")" >&2
    done
    return 1
  fi
  echo "✓ All Monaco LSP language servers are installed"
}

main "$@"
