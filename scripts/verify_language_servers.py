#!/usr/bin/env python3
"""Verify the Monaco LSP `make doctor` section against the install-table (task 12.4).

Design "Setup / doctor verification" (R8.2, R8.3, R8.6):

1. `make doctor` names all three language-server binaries.
2. Every doctor "MISSING (...)" fallback carries a non-empty install command
   (so a *simulated-missing* line always shows how to install the binary).
3. The set of binaries the doctor checks equals the install-table keys, and the
   commands match — so a binary is only ever reported missing when its install
   command is known (R8.6, single source of truth).

Run directly:  python3 scripts/verify_language_servers.py
Exits non-zero (via AssertionError) on any violation.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
MAKEFILE = REPO / "Makefile"
INSTALL_SCRIPT = REPO / "scripts" / "install-language-servers.sh"
EXPECTED_BINARIES = {"pyright-langserver", "typescript-language-server", "rust-analyzer"}

# Matches a doctor line's fallback, e.g.
#   ; pyright-langserver --version 2>/dev/null || echo "MISSING (uv pip install pyright)"
_DOCTOR_LINE = re.compile(
    r';\s*([A-Za-z0-9_-]+)\s+--version[^|]*\|\|\s*echo\s+"MISSING \((.*?)\)"'
)


def doctor_section() -> str:
    """The Makefile 'Language servers (Monaco LSP)' doctor section text."""
    text = MAKEFILE.read_text(encoding="utf-8")
    start = text.index("Language servers (Monaco LSP)")
    end = text.index("Linux runtime deps", start)
    return text[start:end]


def doctor_missing_pairs() -> dict[str, str]:
    """(binary -> install command) parsed from the doctor MISSING fallbacks."""
    return {binary: cmd.strip() for binary, cmd in _DOCTOR_LINE.findall(doctor_section())}


def install_table_pairs() -> dict[str, str]:
    """(binary -> install command) parsed from install-language-servers.sh."""
    text = INSTALL_SCRIPT.read_text(encoding="utf-8")
    match = re.search(r"lsp_server_table\(\)\s*\{\s*cat <<'TABLE'\n(.*?)\nTABLE", text, re.S)
    assert match, "could not find the lsp_server_table heredoc in install-language-servers.sh"
    pairs: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if "|" in line:
            binary, cmd = line.split("|", 1)
            pairs[binary.strip()] = cmd.strip()
    return pairs


def main() -> int:
    doctor = doctor_missing_pairs()
    table = install_table_pairs()

    # (3) The checked-binary set equals the install-table keys (R8.6).
    assert set(doctor) == set(table), f"doctor set {set(doctor)} != table set {set(table)}"
    assert set(table) == EXPECTED_BINARIES, f"table {set(table)} != expected {EXPECTED_BINARIES}"

    # (2) Every reported-missing binary has a non-empty install command that
    #     matches the single source of truth (the install table).
    for binary, cmd in doctor.items():
        assert cmd, f"doctor MISSING line for {binary!r} has no install command"
        assert cmd == table[binary], (
            f"{binary}: doctor command {cmd!r} != install-table command {table[binary]!r}"
        )

    # (1) `make doctor` actually names all three binaries (best-effort: needs make).
    if shutil.which("make"):
        result = subprocess.run(
            ["make", "doctor"],
            cwd=REPO,
            capture_output=True,
            text=True,
            check=False,
        )
        combined = result.stdout + result.stderr
        for binary in EXPECTED_BINARIES:
            assert binary in combined, f"`make doctor` output does not name {binary!r}"

    print("OK: `make doctor` names all three language servers;")
    print("    the checked-binary set equals the install-table keys;")
    print("    every reported-missing binary carries its known install command.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
