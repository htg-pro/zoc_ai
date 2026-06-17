# Security — Secrets & Remediation

## Tooling

- **Pre-commit:** two hooks block secrets before they land —
  [`gitleaks`](https://github.com/gitleaks/gitleaks) (hosted) and an offline
  backup, `scripts/scan_secrets.py`. Install hooks with `pre-commit install`.
- **On demand:** `make scan-secrets` scans both the working tree and the full
  git history. The script is dependency-free (stdlib only), so it runs in CI
  without installing anything.

```bash
python3 scripts/scan_secrets.py            # working tree (tracked files)
python3 scripts/scan_secrets.py --history  # every blob in git history
```

False positives: add an allowlist token (e.g. `REDACTED`, `ROTATE_ME`,
`example`, `your-…`) to the matched line, or extend `ALLOWLIST` in the script.

## Known leaks found (rotate these)

Two real credentials were committed/exposed during development. **Both must be
rotated on the provider side — code cleanup does not undo exposure.**

| Credential | Where | In git history? | Action |
|------------|-------|-----------------|--------|
| Groq API key (`gsk_…`) | working-tree files (TestSprite tests, README scratch, `.claude/`) | **No** (never committed) | Revoke in Groq console, issue a new key |
| GitLab PAT (`glpat-…`) | `README.md` last line | **Yes** — commit `c38f75d` | Revoke in GitLab → Settings → Access Tokens, then purge history (below) |

Both have been removed from the working tree.

## Purging the GitLab PAT from history

The token is still recoverable from commit `c38f75d` even though the current
`README.md` is clean. To fully remove it you must rewrite history. **This is
destructive — it changes commit hashes and requires a force-push. Coordinate
with anyone who has cloned the repo.**

Recommended with [`git filter-repo`](https://github.com/newren/git-filter-repo):

```bash
# 1. Make sure the working tree no longer contains the token (already done).
# 2. Rewrite every commit, replacing the literal token with a placeholder.
cat > /tmp/replacements.txt <<'EOF'
glpat-U452Q5ioK1gbxZ0iHRhr_2M6MQpvOjEKdTpuOTlweg8.01.171w20x6s==>REDACTED_GITLAB_PAT
EOF
git filter-repo --replace-text /tmp/replacements.txt

# 3. Verify, then force-push (only after the token is revoked).
python3 scripts/scan_secrets.py --history   # expect: clean
git push --force-with-lease --all
```

If the repo has only the single `c38f75d` snapshot commit and no remote yet,
the simplest path is to rotate the token, keep the cleaned working tree, and
re-initialize history before the first push.

## Conventions

- Never put real keys in tracked files. Use env vars or gitignored local
  config (`.claude/settings.local.json`, `*.env` are gitignored).
- `make scan-secrets` is part of `make check`, so the gate runs with the rest
  of the quality checks.
