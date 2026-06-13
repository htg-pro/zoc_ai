import pytest
from llama_studio_agent.modes import test_gen
from llama_studio_agent.modes.code_review import findings_from_lint_output, run_code_review
from llama_studio_agent.modes.test_gen import run_test_only
from llama_studio_agent.providers.mock import MockResponse


@pytest.mark.asyncio
async def test_code_review_parses_findings(mock_provider):
    mock_provider.queue(
        MockResponse(
            text=(
                '{"summary": "ok", "findings": ['
                '{"file": "a.py", "line": 3, "severity": "high", "message": "bug"}'
                ']}'
            )
        )
    )
    report = await run_code_review(mock_provider, model="mock-1", diff="--- a/a.py\n+++ b/a.py\n@@\n+x=1\n")
    assert report.summary == "ok"
    assert report.findings[0].severity.value == "high"


def test_findings_from_lint_output():
    text = "src/a.py:10: warning: unused import\nsrc/b.py:2: error: bad\n"
    findings = findings_from_lint_output(text)
    assert {f.file for f in findings} == {"src/a.py", "src/b.py"}


@pytest.mark.asyncio
async def test_run_test_only_passes(tmp_path, monkeypatch):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    test_file = tmp_path / "tests" / "test_foo.py"
    test_file.parent.mkdir(parents=True)
    test_file.write_text("def test_ok():\n    assert True\n")

    monkeypatch.setattr(test_gen.shutil, "which", lambda _bin: "/usr/bin/pytest")
    monkeypatch.setattr(
        test_gen.hotpath,
        "pty_run",
        lambda *a, **k: {"stdout": "1 passed", "exit_code": 0},
    )

    result = await run_test_only(
        workspace_root=str(tmp_path), test_file="tests/test_foo.py", target="foo.py"
    )
    assert result.passed is True
    assert result.attempts == 1
    assert result.last_output == "1 passed"
    assert result.target == "foo.py"


@pytest.mark.asyncio
async def test_run_test_only_reports_failure(tmp_path, monkeypatch):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    test_file = tmp_path / "tests" / "test_foo.py"
    test_file.parent.mkdir(parents=True)
    test_file.write_text("def test_bad():\n    assert False\n")

    monkeypatch.setattr(test_gen.shutil, "which", lambda _bin: "/usr/bin/pytest")
    monkeypatch.setattr(
        test_gen.hotpath,
        "pty_run",
        lambda *a, **k: {"stdout": "1 failed", "exit_code": 1},
    )

    result = await run_test_only(workspace_root=str(tmp_path), test_file="tests/test_foo.py")
    assert result.passed is False
    assert result.last_output == "1 failed"


@pytest.mark.asyncio
async def test_run_test_only_missing_runner(tmp_path, monkeypatch):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    test_file = tmp_path / "tests" / "test_foo.py"
    test_file.parent.mkdir(parents=True)
    test_file.write_text("def test_ok():\n    assert True\n")

    monkeypatch.setattr(test_gen.shutil, "which", lambda _bin: None)

    result = await run_test_only(workspace_root=str(tmp_path), test_file="tests/test_foo.py")
    assert result.passed is False
    assert "runner not available" in (result.last_output or "")


@pytest.mark.asyncio
async def test_run_test_only_missing_file(tmp_path):
    (tmp_path / "pyproject.toml").write_text("[project]\nname='x'\n")
    result = await run_test_only(workspace_root=str(tmp_path), test_file="tests/missing.py")
    assert result.passed is False
    assert "not found" in (result.last_output or "")
