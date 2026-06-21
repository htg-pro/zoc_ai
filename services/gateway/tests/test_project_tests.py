from __future__ import annotations

import json
from pathlib import Path

from zocai_gateway.project_tests import (
    ProjectTestCommand,
    detect_project_test_command,
    run_project_tests,
)


def test_package_json_test_script_has_priority_and_uses_lockfile(tmp_path: Path) -> None:
    (tmp_path / "package.json").write_text(
        json.dumps({"scripts": {"test": "vitest run"}}), encoding="utf-8"
    )
    (tmp_path / "pnpm-lock.yaml").write_text("lockfileVersion: 9\n", encoding="utf-8")
    (tmp_path / "Makefile").write_text("test:\n\tpytest\n", encoding="utf-8")

    detected = detect_project_test_command(tmp_path)

    assert detected == ProjectTestCommand(command="pnpm test", source="package.json")


def test_makefile_and_pyproject_test_detection(tmp_path: Path) -> None:
    (tmp_path / "Makefile").write_text("test::\n\tpython -m pytest\n", encoding="utf-8")
    assert detect_project_test_command(tmp_path) == ProjectTestCommand(
        command="make test", source="Makefile"
    )

    (tmp_path / "Makefile").unlink()
    (tmp_path / "pyproject.toml").write_text(
        '[tool.pdm.scripts]\ntest = "pytest -q"\n', encoding="utf-8"
    )
    assert detect_project_test_command(tmp_path) == ProjectTestCommand(
        command="pdm run test", source="pyproject.toml"
    )


def test_pty_runner_captures_output_and_counts(tmp_path: Path) -> None:
    result = run_project_tests(
        tmp_path,
        ProjectTestCommand(
            command="printf '2 passed, 1 failed\\n'; exit 1",
            source="package.json",
        ),
        timeout_seconds=5,
    )

    assert result.exit_code == 1
    assert result.passed == 2
    assert result.failed == 1
    assert "2 passed, 1 failed" in result.output
    assert result.timed_out is False
