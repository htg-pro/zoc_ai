"""Guard for the dependency-policy gate — zoc-agent-chat-rebuild R5.4, R22.5.

Asserts the script exits non-zero on a synthetic lockfile entry for *each*
banned name and zero on the real lockfile. Parameterised per name rather than
tested once with one name, because the pattern has four alternatives and a
regression that breaks only the `@mastra/` branch would otherwise pass.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1]
REPO_ROOT = SCRIPTS.parent
sys.path.insert(0, str(SCRIPTS))

import deps_policy  # noqa: E402

#: One representative per alternative in `BANNED_PATTERN`, plus the transitive
#: shapes that motivated scanning the lockfile at all.
BANNED_SAMPLES = [
    "langchain",
    "langchain-core",
    "@langchain/openai",
    "@langchain/langgraph",
    "@mastra/core",
    "mastra",
]

#: Names that merely resemble a banned one. A gate that fires on these is a gate
#: someone will disable.
ALLOWED_SAMPLES = [
    "my-langchainish-helper",
    "@acme/langchain-notes",
    "mastraless",
    "ai",
    "@ai-sdk/openai",
]


def _write_lock(tmp_path: Path, package_line: str) -> Path:
    lock = tmp_path / "pnpm-lock.yaml"
    lock.write_text(
        "lockfileVersion: '9.0'\n"
        "\n"
        "packages:\n"
        "\n"
        "  ai@6.0.235:\n"
        "    resolution: {integrity: sha512-deadbeef}\n"
        f"{package_line}"
        "    resolution: {integrity: sha512-cafebabe}\n",
        encoding="utf-8",
    )
    return lock


def _empty_tree(tmp_path: Path) -> Path:
    root = tmp_path / "tree"
    root.mkdir()
    (root / "package.json").write_text(
        json.dumps({"name": "synthetic", "dependencies": {"ai": "6.0.235"}}),
        encoding="utf-8",
    )
    return root


@pytest.mark.parametrize("name", BANNED_SAMPLES)
def test_banned_lockfile_entry_fails(tmp_path: Path, name: str) -> None:
    root = _empty_tree(tmp_path)
    lock = _write_lock(tmp_path, f"  {name}@1.0.0:\n")
    assert deps_policy.run(root, lock) == 1


@pytest.mark.parametrize("name", BANNED_SAMPLES)
def test_banned_lockfile_dependency_edge_fails(tmp_path: Path, name: str) -> None:
    """A transitive edge counts: the install would still fetch the bytes."""
    root = _empty_tree(tmp_path)
    lock = tmp_path / "pnpm-lock.yaml"
    lock.write_text(
        "lockfileVersion: '9.0'\n\nsnapshots:\n\n  some-pkg@1.0.0:\n"
        "    dependencies:\n"
        f"      '{name}': 1.2.3\n",
        encoding="utf-8",
    )
    assert deps_policy.run(root, lock) == 1


@pytest.mark.parametrize("name", BANNED_SAMPLES)
def test_banned_manifest_dependency_fails(tmp_path: Path, name: str) -> None:
    root = _empty_tree(tmp_path)
    (root / "package.json").write_text(
        json.dumps({"name": "synthetic", "dependencies": {name: "^1.0.0"}}),
        encoding="utf-8",
    )
    lock = _write_lock(tmp_path, "  zod@4.4.3:\n")
    assert deps_policy.run(root, lock) == 1


@pytest.mark.parametrize("name", ALLOWED_SAMPLES)
def test_lookalike_names_pass(tmp_path: Path, name: str) -> None:
    root = _empty_tree(tmp_path)
    (root / "package.json").write_text(
        json.dumps({"name": "synthetic", "dependencies": {name: "^1.0.0"}}),
        encoding="utf-8",
    )
    lock = _write_lock(tmp_path, f"  {name}@1.0.0:\n")
    assert deps_policy.run(root, lock) == 0


def test_real_repository_is_clean() -> None:
    """The gate must be green on the tree it actually guards."""
    assert deps_policy.run(REPO_ROOT, REPO_ROOT / "pnpm-lock.yaml") == 0


def test_devdependencies_and_overrides_are_scanned(tmp_path: Path) -> None:
    root = _empty_tree(tmp_path)
    (root / "package.json").write_text(
        json.dumps(
            {
                "name": "synthetic",
                "devDependencies": {"@langchain/core": "1.0.0"},
            }
        ),
        encoding="utf-8",
    )
    assert deps_policy.run(root, _write_lock(tmp_path, "  zod@4.4.3:\n")) == 1

    (root / "package.json").write_text(
        json.dumps({"name": "synthetic", "overrides": {"mastra": "1.0.0"}}),
        encoding="utf-8",
    )
    assert deps_policy.run(root, _write_lock(tmp_path, "  zod@4.4.3:\n")) == 1


def test_nested_workspace_manifests_are_scanned(tmp_path: Path) -> None:
    root = _empty_tree(tmp_path)
    nested = root / "apps" / "thing"
    nested.mkdir(parents=True)
    (nested / "package.json").write_text(
        json.dumps({"name": "thing", "dependencies": {"langchain": "1.0.0"}}),
        encoding="utf-8",
    )
    assert deps_policy.run(root, _write_lock(tmp_path, "  zod@4.4.3:\n")) == 1


def test_node_modules_is_not_scanned(tmp_path: Path) -> None:
    """An installed tree is an artefact; the lockfile is the authority."""
    root = _empty_tree(tmp_path)
    vendored = root / "node_modules" / "langchain"
    vendored.mkdir(parents=True)
    (vendored / "package.json").write_text(
        json.dumps({"name": "langchain", "dependencies": {"langchain": "1.0.0"}}),
        encoding="utf-8",
    )
    assert deps_policy.run(root, _write_lock(tmp_path, "  zod@4.4.3:\n")) == 0


# --- the real entrypoint -------------------------------------------------
# The tests above call `run()` directly, which is fast and lets each banned
# name be parameterised cheaply. These three exercise the path the Build_Gate
# actually takes — `python3 scripts/deps_policy.py` through argparse — so a
# renamed flag or a broken `sys.exit` wiring fails here rather than shipping a
# gate that always reports success.


def test_cli_exits_non_zero_on_banned_lockfile(tmp_path: Path) -> None:
    root = _empty_tree(tmp_path)
    lock = _write_lock(tmp_path, "  @langchain/openai@1.0.0:\n")
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "deps_policy.py"),
            "--root",
            str(root),
            "--lockfile",
            str(lock),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "@langchain/openai" in result.stderr


def test_cli_exits_zero_on_the_real_tree() -> None:
    """No arguments: exactly how `pnpm deps:policy` invokes it."""
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "deps_policy.py")],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
    )
    assert result.returncode == 0, result.stderr


def test_build_gate_wires_the_step() -> None:
    """R22.5: the gate only guards if `check` runs it.

    Asserted as **containment and order**, not as the whole string. The literal
    form was checked here originally and it made this test fail for the one thing
    it should not care about: task 12.4 legitimately inserting `lint:suppressions`
    into the same chain. What the requirement needs is that the step runs, and that
    it runs before `cargo check` so a policy failure short-circuits the slow half.
    """
    scripts_block = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert scripts_block["deps:policy"] == "python3 scripts/deps_policy.py"

    check = scripts_block["check"]
    steps = [step.strip() for step in check.split("&&")]
    assert "pnpm deps:policy" in steps, check
    # The gate is a gate only if a failure stops the build, which `&&` chaining is
    # what provides — a `;` or a trailing position after `cargo check` would not.
    assert steps.index("pnpm deps:policy") < steps.index("cargo check --workspace"), check
    for required in ("pnpm schema:check", "pnpm lint", "pnpm typecheck"):
        assert required in steps, check
