"""``python -m zocai_migration`` entrypoint.

Delegates to :func:`zocai_migration.cli.main`, the single CLI the 9.x deletion
tasks call so the preservation-branch + replace-before-delete discipline is
enforced in one place (task 1.1).
"""

from __future__ import annotations

from zocai_migration.cli import main

if __name__ == "__main__":
    raise SystemExit(main())
