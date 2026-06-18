"""Single CLI entrypoint for the migration deletion discipline (task 1.1).

The later cutover tasks (9.x) never delete a legacy directory directly. They
call this one entrypoint so the preservation-branch precondition and the
replace-before-delete rule are enforced in exactly one place:

    python -m zocai_migration verify-branch --repo .
    python -m zocai_migration delete \
        --repo . \
        --legacy services/agent \
        --replacement-module zocai_gateway \
        --replacement-path services/gateway

``verify-branch`` checks that the committed ``legacy-preservation`` branch
exists and exits non-zero if it does not. ``delete`` enforces both gates and
removes the legacy directory only when they pass; any refusal exits non-zero
with a reason-specific code (see :data:`zocai_migration.guard._EXIT_CODES`).

The command wires the real :class:`~zocai_migration.git_vcs.GitVersionControl`
branch inspector and an on-disk filesystem rooted at ``--repo`` into the pure
:class:`~zocai_migration.guard.DeletionGuard`.
"""

from __future__ import annotations

import argparse
from collections.abc import Sequence

from zocai_migration.controller import DEFAULT_BRANCH_NAME
from zocai_migration.git_vcs import GitVersionControl, git_available
from zocai_migration.guard import (
    DeletionGuard,
    GuardError,
    OnDiskFileSystem,
    ReplacementSpec,
)

__all__ = ["build_parser", "main"]

_PROG = "zocai-migration"

# Exit codes for conditions handled by the CLI shell rather than a GuardOutcome.
_EXIT_GIT_UNAVAILABLE = 5
# Invalid CLI request mirrors the guard's INVALID_REQUEST exit code (2).
_EXIT_CODES_INVALID = 2


def build_parser() -> argparse.ArgumentParser:
    """Construct the argument parser for the migration guard CLI."""
    parser = argparse.ArgumentParser(
        prog=_PROG,
        description=(
            "Preservation-branch + replace-before-delete guard for the legacy "
            "cutover. The single entrypoint the 9.x deletion tasks call."
        ),
    )
    parser.add_argument(
        "--repo",
        default=".",
        help="Path to the git working repository (default: current directory).",
    )
    parser.add_argument(
        "--branch",
        default=DEFAULT_BRANCH_NAME,
        help=(
            "Name of the committed preservation branch that must exist before "
            f"any deletion (default: {DEFAULT_BRANCH_NAME!r})."
        ),
    )

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser(
        "verify-branch",
        help="Verify the committed preservation branch exists; exit non-zero otherwise.",
    )

    delete = sub.add_parser(
        "delete",
        help="Delete a legacy directory once both deletion gates pass.",
    )
    delete.add_argument(
        "--legacy",
        required=True,
        help="Workspace-relative path of the legacy directory to remove.",
    )
    delete.add_argument(
        "--replacement-module",
        default=None,
        help="Importable module name that must replace the legacy directory.",
    )
    delete.add_argument(
        "--replacement-path",
        default=None,
        help="Workspace-relative path of the replacement that must exist.",
    )
    delete.add_argument(
        "--label",
        default=None,
        help="Optional human-readable label for the deletion in log output.",
    )
    return parser


def _build_guard(args: argparse.Namespace) -> DeletionGuard:
    inspector = GitVersionControl(args.repo)
    filesystem = OnDiskFileSystem(args.repo)
    return DeletionGuard(
        branch_inspector=inspector,
        filesystem=filesystem,
        branch_name=args.branch,
    )


def main(argv: Sequence[str] | None = None) -> int:
    """Run the guard CLI and return a process exit code (0 = success)."""
    parser = build_parser()
    args = parser.parse_args(argv)

    if not git_available():
        print(
            "error: a 'git' executable is required to verify the preservation "
            "branch but was not found on PATH.",
        )
        return _EXIT_GIT_UNAVAILABLE

    guard = _build_guard(args)

    if args.command == "verify-branch":
        outcome = guard.check_preservation_branch()
        print(outcome.message)
        return outcome.exit_code

    if args.command == "delete":
        try:
            spec = ReplacementSpec(
                legacy_path=args.legacy,
                replacement_module=args.replacement_module,
                replacement_path=args.replacement_path,
                label=args.label,
            )
        except ValueError as exc:
            print(f"error: {exc}")
            return _EXIT_CODES_INVALID
        try:
            outcome = guard.delete(spec)
        except GuardError as exc:
            print(f"error: {exc.outcome.message}")
            return exc.exit_code
        print(outcome.message)
        return outcome.exit_code

    # argparse with required subparsers makes this unreachable.
    parser.error(f"unknown command: {args.command!r}")  # pragma: no cover
    return _EXIT_CODES_INVALID  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
