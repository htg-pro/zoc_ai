"""Project validation suite — discover and run a project's real checks.

Extracted from the (now-deleted) legacy ``replit_workflow`` module so the
checks survive its removal. Used by the isolated-run flow (``zoc_run``) to
validate changes before review, and by the ``run_tests`` tool. Pure of any
planning/Replit concepts — just filesystem inspection + subprocess.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

_MAX_VALIDATION_OUTPUT = 24_000


@dataclass(slots=True)
class ValidationCommand:
    label: str
    cmd: list[str]
    cwd: Path


@dataclass(slots=True)
class ValidationResult:
    label: str
    command: str
    exit_code: int
    output: str

    @property
    def passed(self) -> bool:
        return self.exit_code == 0


def discover_validation_commands(root: Path) -> list[ValidationCommand]:
    """Pick the strongest real validation commands for this project layout.

    Prefers `uv run pytest`, `ruff check`, and per-package `pnpm --filter`
    commands derived from `pnpm-workspace.yaml` so readiness reflects the
    project's actual checks rather than a generic compile pass.
    """

    commands: list[ValidationCommand] = []
    uv_available = shutil.which("uv") is not None

    # ── JavaScript / TypeScript ────────────────────────────────────────
    has_root_pkg = (root / "package.json").exists()
    has_nested_pkg = (root / "apps" / "frontend" / "package.json").exists()
    if has_root_pkg or has_nested_pkg:
        runner = "pnpm" if (root / "pnpm-lock.yaml").exists() or (root / "pnpm-workspace.yaml").exists() else "npm"
        ws_packages = _discover_pnpm_workspace_packages(root) if runner == "pnpm" else []
        added_filtered = False
        for pkg_name, scripts in ws_packages:
            for script in ("typecheck", "test", "build"):
                if script in scripts:
                    commands.append(
                        ValidationCommand(
                            f"{pkg_name} {script}",
                            ["pnpm", "--filter", pkg_name, script],
                            root,
                        )
                    )
                    added_filtered = True
        if not added_filtered:
            if runner == "pnpm":
                commands.append(ValidationCommand("TypeScript", ["pnpm", "typecheck"], root))
                commands.append(
                    ValidationCommand(
                        "Frontend build",
                        ["pnpm", "--filter", "@llama-studio/frontend", "build"],
                        root,
                    )
                )
            else:
                commands.append(ValidationCommand("TypeScript", ["npm", "run", "typecheck"], root))
                commands.append(ValidationCommand("Frontend build", ["npm", "run", "build"], root))

    # ── Python ─────────────────────────────────────────────────────────
    pyproject = root / "pyproject.toml"
    nested_pyproject = root / "services" / "agent" / "pyproject.toml"
    if pyproject.exists() or nested_pyproject.exists():
        if uv_available:
            commands.append(
                ValidationCommand(
                    "Python tests",
                    ["uv", "run", "pytest", "services/agent/tests"],
                    root,
                )
            )
        else:
            commands.append(
                ValidationCommand(
                    "Python tests",
                    ["python", "-m", "pytest", "services/agent/tests"],
                    root,
                )
            )
        commands.append(
            ValidationCommand(
                "Python compile",
                ["python", "-m", "compileall", "services", "packages"],
                root,
            )
        )
        if _has_ruff_config(pyproject if pyproject.exists() else nested_pyproject):
            ruff_cmd = (
                ["uv", "run", "ruff", "check", "services", "packages"]
                if uv_available
                else ["ruff", "check", "services", "packages"]
            )
            commands.append(ValidationCommand("Ruff lint", ruff_cmd, root))
    elif any(root.glob("**/*.py")):
        commands.append(ValidationCommand("Python compile", ["python", "-m", "compileall", "."], root))

    # ── Rust / Tauri ───────────────────────────────────────────────────
    if (root / "Cargo.toml").exists() or (root / "src-tauri" / "Cargo.toml").exists():
        commands.append(ValidationCommand("Rust/Tauri check", ["cargo", "check", "--workspace"], root))

    # ── Packaging smoke ────────────────────────────────────────────────
    if (root / "scripts" / "verify_zip.py").exists():
        commands.append(ValidationCommand("Startup smoke", ["python", "scripts/verify_zip.py", "--help"], root))

    if not commands:
        commands.append(ValidationCommand("Python compile", ["python", "-m", "compileall", "."], root))
    return commands


def _discover_pnpm_workspace_packages(root: Path) -> list[tuple[str, set[str]]]:
    """Return `(package_name, scripts)` for each package listed in `pnpm-workspace.yaml`.

    Best-effort: missing/garbled YAML and package.json files are skipped silently
    so discovery never crashes.
    """

    workspace_file = root / "pnpm-workspace.yaml"
    if not workspace_file.exists():
        return []
    try:
        raw = workspace_file.read_text(encoding="utf-8")
    except OSError:
        return []
    patterns: list[str] = []
    in_packages = False
    for line in raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("packages:"):
            in_packages = True
            continue
        if in_packages:
            if stripped.startswith("- "):
                value = stripped[2:].strip().strip("'\"")
                if value:
                    patterns.append(value)
            elif stripped and not stripped.startswith("#") and not stripped.startswith("- "):
                in_packages = False
    out: list[tuple[str, set[str]]] = []
    for pattern in patterns:
        for pkg_dir in sorted(root.glob(pattern)):
            pkg_json = pkg_dir / "package.json"
            if not pkg_json.is_file():
                continue
            try:
                import json as _json

                data = _json.loads(pkg_json.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            name = data.get("name")
            if not isinstance(name, str):
                continue
            scripts = data.get("scripts") or {}
            script_names = {k for k in scripts if isinstance(k, str)}
            out.append((name, script_names))
    return out


def _has_ruff_config(pyproject: Path) -> bool:
    if not pyproject.is_file():
        return False
    try:
        text = pyproject.read_text(encoding="utf-8")
    except OSError:
        return False
    return "[tool.ruff" in text


def run_validation_suite(root: Path) -> list[ValidationResult]:
    results: list[ValidationResult] = []
    for spec in discover_validation_commands(root):
        rendered = " ".join(spec.cmd)
        if shutil.which(spec.cmd[0]) is None:
            results.append(ValidationResult(spec.label, rendered, 127, f"SKIPPED: executable not found: {spec.cmd[0]}"))
            continue
        try:
            completed = subprocess.run(
                spec.cmd,
                cwd=spec.cwd,
                text=True,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                timeout=180,
                check=False,
            )
            output = (completed.stdout or "")[-_MAX_VALIDATION_OUTPUT:]
            results.append(ValidationResult(spec.label, rendered, completed.returncode, output))
        except subprocess.TimeoutExpired as exc:
            output = ((exc.stdout or "") if isinstance(exc.stdout, str) else "")[-_MAX_VALIDATION_OUTPUT:]
            results.append(ValidationResult(spec.label, rendered, 124, output + "\nTIMEOUT"))
    return results


def format_validation_results(results: list[ValidationResult]) -> str:
    if not results:
        return "NO ERROR\nNo validation commands were discovered."
    lines = []
    all_passed = all(r.passed for r in results)
    lines.append("NO ERROR" if all_passed else "ERROR")
    for result in results:
        status = "PASS" if result.passed else "FAIL"
        lines.append(f"\n[{status}] {result.label}")
        lines.append(f"$ {result.command}")
        lines.append(f"exit_code={result.exit_code}")
        if result.output.strip():
            lines.append(result.output.strip())
    return "\n".join(lines).strip()


__all__ = [
    "ValidationCommand",
    "ValidationResult",
    "discover_validation_commands",
    "format_validation_results",
    "run_validation_suite",
]
