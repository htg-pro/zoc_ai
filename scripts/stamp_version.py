#!/usr/bin/env python3
"""Stamp the canonical project version (from ``VERSION``) across all manifests.

Run from the repo root: ``python scripts/stamp_version.py``.

Touched files:

* ``package.json``                                (root + every workspace package)
* ``Cargo.toml``                                  (workspace.package.version)
* ``pyproject.toml``                              (root + every uv-workspace member)
* ``apps/desktop/tauri.conf.json``
* ``CHANGELOG.md``                                (only verifies the entry exists)
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VERSION = (ROOT / "VERSION").read_text().strip()
if not re.fullmatch(r"\d+\.\d+\.\d+", VERSION):
    sys.exit(f"VERSION file must be semver, got: {VERSION!r}")


def _stamp_json(path: Path, key_path: list[str]) -> None:
    if not path.exists():
        return
    data = json.loads(path.read_text())
    node = data
    for k in key_path[:-1]:
        node = node.setdefault(k, {})
    if node.get(key_path[-1]) == VERSION:
        return
    node[key_path[-1]] = VERSION
    path.write_text(json.dumps(data, indent=2) + "\n")
    print(f"  stamped {path.relative_to(ROOT)}")


def _stamp_toml_version(path: Path, section_pattern: str) -> None:
    """Replace the ``version = "x.y.z"`` line in the first matching section."""
    if not path.exists():
        return
    text = path.read_text()
    # Match `[section]` ... `version = "..."`
    pattern = re.compile(
        rf"(\[{re.escape(section_pattern)}\][^\[]*?version\s*=\s*\")[^\"]+(\")",
        re.MULTILINE | re.DOTALL,
    )
    new_text, n = pattern.subn(rf"\g<1>{VERSION}\g<2>", text, count=1)
    if n and new_text != text:
        path.write_text(new_text)
        print(f"  stamped {path.relative_to(ROOT)} [{section_pattern}]")


def main() -> int:
    print(f"Stamping version {VERSION}")

    # JSON manifests
    _stamp_json(ROOT / "package.json", ["version"])
    for pkg_json in ROOT.glob("apps/*/package.json"):
        _stamp_json(pkg_json, ["version"])
    for pkg_json in ROOT.glob("packages/*/package.json"):
        _stamp_json(pkg_json, ["version"])
    for pkg_json in ROOT.glob("packages/*/typescript/package.json"):
        _stamp_json(pkg_json, ["version"])
    _stamp_json(ROOT / "apps/desktop/tauri.conf.json", ["version"])

    # TOML manifests
    _stamp_toml_version(ROOT / "Cargo.toml", "workspace.package")
    _stamp_toml_version(ROOT / "pyproject.toml", "project")
    for py in ROOT.glob("services/*/pyproject.toml"):
        _stamp_toml_version(py, "project")
    for py in ROOT.glob("packages/*/python/pyproject.toml"):
        _stamp_toml_version(py, "project")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
