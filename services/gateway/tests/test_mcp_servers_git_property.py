"""Property + unit tests for the bundled git-history MCP server (Part 4, R16).

Every git invocation is driven through a fake ``run_git`` seam, so no real
subprocess is ever spawned and nothing touches a remote. Path confinement is
verified against a fixed, resolved workspace root that need not exist on disk.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

from hypothesis import given, settings
from hypothesis import strategies as st
from mcp_servers.git_history import git_blame, git_log, git_show, resolve_within

# A fixed, already-resolved workspace root. `resolve_within` works on
# non-existent paths, so this need not be created.
_ROOT = (Path(tempfile.gettempdir()) / "zoc-mcp-git-workspace").resolve()
_ROOT_ARGV_PREFIX = ["git", "-C", str(_ROOT)]


class _RecordingRunner:
    """A fake ``GitRunner`` that records every argv and returns a fixed result."""

    def __init__(self, returncode: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.calls: list[list[str]] = []
        self._returncode = returncode
        self._stdout = stdout
        self._stderr = stderr

    def __call__(self, argv: list[str]) -> tuple[int, str, str]:
        self.calls.append(argv)
        return self._returncode, self._stdout, self._stderr


class _RaisingRunner:
    """A fake ``GitRunner`` that records the argv then raises (a spawn failure)."""

    def __init__(self, exc: Exception) -> None:
        self.calls: list[list[str]] = []
        self._exc = exc

    def __call__(self, argv: list[str]) -> tuple[int, str, str]:
        self.calls.append(argv)
        raise self._exc


_safe_seg = st.text(
    alphabet="abcdefghijklmnopqrstuvwxyz0123456789_-", min_size=1, max_size=6
)
_within_path = st.lists(_safe_seg, max_size=4).map("/".join)
_escaping_path = st.one_of(
    st.just(".."),
    st.builds(lambda parts: "../" + parts, _within_path.filter(bool)),
    st.builds(lambda parts: "/" + parts, _within_path.filter(bool)),
    st.just("../../etc/passwd"),
    st.just("a/../../b"),
    st.just("x\x00y"),  # embedded null byte → resolution failure, fail closed
)


# Feature: mcp-host-and-servers, Property 30: git argv + workspace confinement
@settings(max_examples=200)
@given(rel=st.one_of(_within_path, _escaping_path), n=st.integers(min_value=1, max_value=20))
def test_git_argv_and_workspace_confinement(rel: str, n: int) -> None:
    """Validates: Requirements 16.2, 16.9, 16.10, 16.11, 16.12."""
    resolved = resolve_within(_ROOT, rel)

    # git_log confines its optional `path` (R16.2, R16.12).
    log_runner = _RecordingRunner(returncode=0, stdout="")
    log_result = git_log(_ROOT, log_runner, rel, n)
    if resolved is None:
        assert log_result["isError"] is True  # R16.11: escape → typed failure
        assert log_runner.calls == []  # ...and git is NEVER invoked
    else:
        assert log_result["isError"] is False
        assert len(log_runner.calls) == 1
        argv = log_runner.calls[0]
        assert isinstance(argv, list)  # R16.9: argv is a list
        assert argv[:3] == _ROOT_ARGV_PREFIX  # R16.9: git -C <workspace_root>
        assert "log" in argv
        assert str(resolved) in argv  # R16.2/R16.10: path resolved against root

    # git_blame confines its required `file` identically (R16.12).
    blame_runner = _RecordingRunner(returncode=0, stdout="blame output")
    blame_result = git_blame(_ROOT, blame_runner, rel, 1, 5)
    if resolved is None:
        assert blame_result["isError"] is True
        assert blame_runner.calls == []
    else:
        assert blame_result["isError"] is False
        argv = blame_runner.calls[0]
        assert isinstance(argv, list)
        assert argv[:3] == _ROOT_ARGV_PREFIX
        assert "blame" in argv
        assert str(resolved) in argv


# Feature: mcp-host-and-servers, Property 31: git line-range validation before invocation
@settings(max_examples=200)
@given(
    start=st.integers(min_value=1, max_value=10_000),
    delta=st.integers(min_value=1, max_value=10_000),
    file=st.one_of(st.just("src/app.py"), _within_path.filter(bool), _escaping_path),
)
def test_git_blame_line_range_validated_before_invocation(
    start: int, delta: int, file: str
) -> None:
    """Validates: Requirements 16.5."""
    line_start = start + delta  # strictly greater than line_end
    line_end = start
    runner = _RecordingRunner()

    result = git_blame(_ROOT, runner, file, line_start, line_end)

    assert result["isError"] is True  # inverted range → typed failure
    assert runner.calls == []  # ...before git is invoked


# Feature: mcp-host-and-servers, Property 32: git log entry cap
@settings(max_examples=200)
@given(
    n=st.integers(min_value=1, max_value=50),
    line_count=st.integers(min_value=0, max_value=120),
)
def test_git_log_caps_entries_at_n(n: int, line_count: int) -> None:
    """Validates: Requirements 16.3."""
    stdout = "".join(f"{i:040x} commit message {i}\n" for i in range(line_count))
    runner = _RecordingRunner(returncode=0, stdout=stdout)

    result = git_log(_ROOT, runner, None, n)

    assert result["isError"] is False
    entries = result["entries"]
    assert isinstance(entries, list)
    assert len(entries) <= n  # R16.3: no more than n entries


def _run_op(op: str) -> dict[str, object]:
    """Run one isolated git invocation for the given op tag."""
    if op == "log_ok":
        return git_log(_ROOT, _RecordingRunner(0, "a1b2c3 initial commit\n"), "src", 10)
    if op == "log_escape":
        runner = _RecordingRunner(0, "should not run")
        outcome = git_log(_ROOT, runner, "../../etc", 10)
        assert runner.calls == []  # confinement: git not invoked
        return outcome
    if op == "blame_ok":
        return git_blame(_ROOT, _RecordingRunner(0, "^a1b2 (author) line\n"), "a.txt", 1, 3)
    if op == "blame_badrange":
        runner = _RecordingRunner()
        outcome = git_blame(_ROOT, runner, "a.txt", 9, 2)
        assert runner.calls == []
        return outcome
    if op == "show_ok":
        return git_show(_ROOT, _RecordingRunner(0, "commit a1b2\n"), "a1b2")
    if op == "spawn_fail":
        return git_show(_ROOT, _RaisingRunner(FileNotFoundError("git not found")), "a1b2")
    # "nonzero"
    return git_show(_ROOT, _RecordingRunner(128, "", "fatal: bad object"), "deadbeef")


_FAILING_OPS = {"log_escape", "blame_badrange", "spawn_fail", "nonzero"}
_op = st.sampled_from(
    ["log_ok", "log_escape", "blame_ok", "blame_badrange", "show_ok", "spawn_fail", "nonzero"]
)


# Feature: mcp-host-and-servers, Property 33: git per-invocation failure isolation
@settings(max_examples=200)
@given(ops=st.lists(_op, min_size=1, max_size=8))
def test_git_per_invocation_failure_isolation(ops: list[str]) -> None:
    """Validates: Requirements 16.13, 16.16."""
    outcomes = [(op, _run_op(op)) for op in ops]

    # Each invocation's outcome depends only on its own inputs, regardless of the
    # success or failure of any other invocation in the sequence.
    for op, outcome in outcomes:
        assert outcome["isError"] is (op in _FAILING_OPS)


def test_git_spawn_failure_is_typed_failure() -> None:
    """Validates: Requirements 16.14."""
    runner = _RaisingRunner(FileNotFoundError("git binary missing"))
    result = git_show(_ROOT, runner, "HEAD")
    assert result["isError"] is True
    assert "output" not in result  # no partial content


def test_git_nonzero_exit_typed_failure_includes_stderr() -> None:
    """Validates: Requirements 16.15."""
    runner = _RecordingRunner(returncode=128, stdout="", stderr="fatal: bad revision 'nope'")
    result = git_show(_ROOT, runner, "nope")
    assert result["isError"] is True
    assert "fatal: bad revision 'nope'" in result["content"][0]["text"]
