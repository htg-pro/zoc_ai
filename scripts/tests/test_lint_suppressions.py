"""Guard for the lint-suppression gate — zoc-agent-chat-rebuild R22.5, task 12.4.

The interesting cases are the two boundaries, and both are asserted from a
synthetic diff rather than from the repository: what the gate *rejects* (a new
suppression in either guarded tree, in any of its syntactic forms) and what it
deliberately *permits* (the same suppression under `features/agent`, which lives
until task 26.2 and is full of them).

The reported line number is checked too. A gate that named the wrong line is a
gate a reviewer stops trusting, and getting it right from a unified diff means
tracking the hunk header rather than counting from the top of the file.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import lint_suppressions  # noqa: E402

CHAT = "apps/frontend/src/features/chat/wire/zoc-transport.ts"
RUNTIME = "apps/agent-runtime/src/main.ts"
LEGACY = "apps/frontend/src/features/agent/rows.tsx"


def diff_for(path: str, added: list[str], start: int = 41) -> str:
    body = "\n".join(f"+{line}" for line in added)
    return (
        f"diff --git a/{path} b/{path}\n"
        f"--- a/{path}\n"
        f"+++ b/{path}\n"
        f"@@ -40,0 +{start},{len(added)} @@\n"
        f"{body}\n"
    )


def run(diff: str, tmp_path: Path) -> subprocess.CompletedProcess[str]:
    patch = tmp_path / "change.patch"
    patch.write_text(diff, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "lint_suppressions.py"), "--diff-file", str(patch)],
        capture_output=True,
        text=True,
        check=False,
    )


#: Every form the directive takes. Parameterised rather than tested once, because
#: the pattern has several alternatives and a regression that broke only the
#: block-comment branch would otherwise pass.
SUPPRESSION_FORMS = [
    "// eslint-disable-next-line no-console",
    "/* eslint-disable no-console */",
    "const x = 1; // eslint-disable-line no-console",
    "// @ts-ignore",
    "// @ts-expect-error a reason",
    "// @ts-nocheck",
]


@pytest.mark.parametrize("form", SUPPRESSION_FORMS)
@pytest.mark.parametrize("path", [CHAT, RUNTIME])
def test_rejects_an_added_suppression_in_either_guarded_tree(
    form: str, path: str, tmp_path: Path
) -> None:
    result = run(diff_for(path, [form]), tmp_path)
    assert result.returncode == 1
    assert path in result.stderr


@pytest.mark.parametrize("form", SUPPRESSION_FORMS)
def test_permits_the_same_suppression_under_the_legacy_panel(form: str, tmp_path: Path) -> None:
    # `features/agent` lives until 26.2 and is full of these. A repository-wide gate
    # would fail the Build_Gate on code already scheduled for deletion.
    result = run(diff_for(LEGACY, [form]), tmp_path)
    assert result.returncode == 0


def test_permits_eslint_enable(tmp_path: Path) -> None:
    # Re-enabling a rule is the *fix* for a suppression, so matching it would reject
    # the change that removes one.
    result = run(diff_for(CHAT, ["/* eslint-enable no-console */"]), tmp_path)
    assert result.returncode == 0


def test_permits_an_ordinary_change(tmp_path: Path) -> None:
    result = run(diff_for(CHAT, ["const answer = 42;"]), tmp_path)
    assert result.returncode == 0


def test_ignores_a_removed_suppression(tmp_path: Path) -> None:
    # The direction that must never fail: deleting a suppression is the outcome the
    # gate exists to encourage.
    diff = (
        f"diff --git a/{CHAT} b/{CHAT}\n"
        f"--- a/{CHAT}\n"
        f"+++ b/{CHAT}\n"
        "@@ -41,1 +41,0 @@\n"
        "-// eslint-disable-next-line no-console\n"
    )
    result = run(diff, tmp_path)
    assert result.returncode == 0


def test_reports_the_line_number_from_the_hunk_header(tmp_path: Path) -> None:
    diff = diff_for(
        CHAT,
        ["const a = 1;", "const b = 2;", "// eslint-disable-next-line no-console"],
        start=100,
    )
    result = run(diff, tmp_path)
    assert result.returncode == 1
    # Third added line in a hunk starting at 100.
    assert f"{CHAT}:102" in result.stderr


def test_ignores_a_deletion_whose_post_image_is_dev_null(tmp_path: Path) -> None:
    # A deleted file's `+++` is `/dev/null`, and treating that as a path would make
    # every whole-file deletion look like an addition in an unguarded tree.
    diff = (
        f"diff --git a/{CHAT} b/{CHAT}\n"
        f"--- a/{CHAT}\n"
        "+++ /dev/null\n"
        "@@ -41,1 +0,0 @@\n"
        "-// eslint-disable-next-line no-console\n"
    )
    assert run(diff, tmp_path).returncode == 0


def test_the_guarded_trees_hold_no_suppression_today(tmp_path: Path) -> None:
    # The audit mode against the real repository. The gate only ever sees a diff, so a
    # suppression predating it would be invisible to both — this is what makes the
    # count checkable.
    del tmp_path
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "lint_suppressions.py"), "--audit"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_parses_a_multi_file_diff(tmp_path: Path) -> None:
    # One patch touching a guarded and an unguarded tree: the guarded hit is reported
    # and the other is not, which is the state-machine bug a single-file test misses.
    diff = diff_for(LEGACY, ["// @ts-ignore"]) + diff_for(
        RUNTIME, ["// eslint-disable-next-line no-console"]
    )
    result = run(diff, tmp_path)
    assert result.returncode == 1
    assert RUNTIME in result.stderr
    assert LEGACY not in result.stderr


def test_is_guarded_covers_both_trees_and_nothing_else() -> None:
    assert lint_suppressions.is_guarded(CHAT)
    assert lint_suppressions.is_guarded(RUNTIME)
    assert not lint_suppressions.is_guarded(LEGACY)
    assert not lint_suppressions.is_guarded("apps/frontend/src/lib/store.ts")
