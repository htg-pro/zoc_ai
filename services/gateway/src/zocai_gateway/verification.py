"""Framework-aware parsing for Agent verification command output."""

from __future__ import annotations

import re
from dataclasses import dataclass

_FAILURE_PATTERNS = (
    re.compile(r"(?m)^FAILED\s+(.+?)\s*$"),
    re.compile(r"(?m)^\s*●\s+(.+?)\s*$"),
    re.compile(r"(?m)^FAIL\s+([^\s]+.*?)\s*$"),
    re.compile(r"(?m)^test\s+(.+?)\s+\.\.\.\s+FAILED\s*$"),
    re.compile(r"(?m)^--- FAIL:\s+([^\s(]+).*$"),
)


@dataclass(frozen=True, slots=True)
class VerifyResult:
    passed: bool
    failures: list[str]
    output: str


def parse_verify_result(command: str, output: str, exit_code: int) -> VerifyResult:
    """Normalize common test-runner failures without discarding full output."""
    if exit_code == 0:
        return VerifyResult(passed=True, failures=[], output=output)

    failures: list[str] = []
    seen: set[str] = set()
    for pattern in _FAILURE_PATTERNS:
        for match in pattern.findall(output):
            failure = " ".join(match.strip().split())
            if failure and failure not in seen:
                seen.add(failure)
                failures.append(failure)
                if len(failures) >= 50:
                    break
        if len(failures) >= 50:
            break
    if not failures:
        failures.append(f"{command or 'verification'} exited with code {exit_code}")
    return VerifyResult(passed=False, failures=failures, output=output)


__all__ = ["VerifyResult", "parse_verify_result"]
