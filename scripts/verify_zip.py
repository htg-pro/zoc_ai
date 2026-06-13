#!/usr/bin/env python3
"""Validate a Llama Studio release zip.

Asserts:
  * top-level directory is ``llama-studio-v<version>/``
  * cleaned source tree (no node_modules/target/legacy/etc.)
  * required files present (Cargo.toml, package.json, VERSION, README,
    CHANGELOG, scripts/release.sh, tauri.conf.json)
  * RELEASE_MANIFEST.txt present
  * at least one installer under dist/installers/ — unless ``--source-only``

Exit non-zero on any violation.
"""
from __future__ import annotations

import argparse
import re
import sys
import zipfile
from pathlib import Path

FORBIDDEN = (
    "/node_modules/",
    "/.git/",
    "/legacy/",
    "/target/",
    "/.venv/",
    "/.pythonlibs/",
    "/__pycache__/",
    "/.pytest_cache/",
    "/.mypy_cache/",
    "/.ruff_cache/",
    "/.cache/",
    "/.local/",
)
REQUIRED = (
    "Cargo.toml",
    "package.json",
    "VERSION",
    "README.md",
    "CHANGELOG.md",
    "scripts/release.sh",
    "scripts/make_zip.sh",
    "scripts/stamp_version.py",
    "scripts/bundle_sidecar.py",
    "apps/desktop/tauri.conf.json",
    "RELEASE_MANIFEST.txt",
)
INSTALLER_EXTS = (".tar.gz", ".deb", ".rpm", ".msi", ".exe", ".dmg")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("zip", type=Path)
    ap.add_argument("--source-only", action="store_true",
                    help="Don't require installer artifacts in dist/installers/.")
    args = ap.parse_args()

    if not args.zip.exists():
        print(f"!! Zip not found: {args.zip}", file=sys.stderr)
        return 2

    z = zipfile.ZipFile(args.zip)
    names = z.namelist()
    if not names:
        print("!! Zip is empty.", file=sys.stderr)
        return 2

    tops = {n.split("/", 1)[0] for n in names}
    if len(tops) != 1:
        print(f"!! Expected a single top-level dir, got: {sorted(tops)}", file=sys.stderr)
        return 2
    top = next(iter(tops))
    if not re.fullmatch(r"llama-studio-v\d+\.\d+\.\d+", top):
        print(f"!! Top-level dir must match llama-studio-v<semver>, got: {top!r}",
              file=sys.stderr)
        return 2

    errors: list[str] = []

    for n in names:
        for bad in FORBIDDEN:
            if bad in "/" + n:
                errors.append(f"forbidden path in zip: {n}")
                break

    have = set(names)
    for req in REQUIRED:
        if f"{top}/{req}" not in have:
            errors.append(f"missing required entry: {req}")

    installers = [
        n for n in names
        if n.startswith(f"{top}/dist/installers/")
        and (n.endswith(INSTALLER_EXTS) or ("/dist/installers/" in n and n.rstrip("/").endswith(".app")))
    ]
    # also accept anything *inside* a .app bundle
    app_bundles = {
        n.split("/dist/installers/", 1)[1].split("/", 1)[0]
        for n in names if "/dist/installers/" in n and ".app/" in n
    }
    has_installer = bool(installers) or any(b.endswith(".app") for b in app_bundles)

    if not args.source_only and not has_installer:
        errors.append(
            "no installer artifacts under dist/installers/ — a full release "
            "must include at least one .tar.gz/.deb/.rpm/.msi/.exe/.dmg/.app"
        )

    if errors:
        print("!! Zip verification FAILED:", file=sys.stderr)
        for e in errors:
            print(f"   - {e}", file=sys.stderr)
        return 1

    mode = "source-only" if not has_installer else "full"
    print(f"OK: {args.zip.name} ({len(names)} entries, mode={mode})")
    if has_installer:
        for i in installers:
            print(f"   installer: {i.split('/dist/installers/', 1)[1]}")
        for b in sorted(app_bundles):
            print(f"   bundle:    {b}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
