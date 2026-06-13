"""Test generation mode.

Detects the project's test framework, asks the LLM to write a test file
for the target, writes it via the filesystem tool, runs it via
`run_command`, and loops on failure up to the orchestrator's repair budget.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID

from shared_schema.models import TestGenerationResult

from .. import hotpath
from ..agent.orchestrator import AgentOrchestrator, OrchestratorConfig
from ..providers.base import ChatMessage, ChatRequest, LLMProvider


@dataclass(slots=True)
class FrameworkInfo:
    name: str
    runner: list[str]  # argv used to run a single test file
    suffix: str  # file name suffix


def detect_framework(root: str) -> FrameworkInfo:
    rootp = Path(root)
    if (rootp / "pyproject.toml").exists() or (rootp / "pytest.ini").exists() or any(rootp.rglob("test_*.py")):
        return FrameworkInfo(name="pytest", runner=["pytest", "-q"], suffix="_test.py")
    if (rootp / "package.json").exists():
        if (rootp / "vitest.config.ts").exists() or (rootp / "vitest.config.js").exists():
            return FrameworkInfo(name="vitest", runner=["pnpm", "test"], suffix=".test.ts")
        return FrameworkInfo(name="jest", runner=["pnpm", "test"], suffix=".test.ts")
    if (rootp / "Cargo.toml").exists():
        return FrameworkInfo(name="cargo", runner=["cargo", "test"], suffix=".rs")
    return FrameworkInfo(name="pytest", runner=["pytest", "-q"], suffix="_test.py")


TEST_SYSTEM = (
    "You write focused, idiomatic unit tests in the user's existing test"
    " framework. Reply with a single fenced code block containing the test"
    " source — no prose, no commentary."
)


def _extract_code(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        # strip opening fence (optionally with language) and closing fence
        first_nl = text.find("\n")
        body = text[first_nl + 1 :] if first_nl != -1 else text[3:]
        if body.endswith("```"):
            body = body[:-3]
        return body.rstrip() + "\n"
    return text + "\n"


async def run_test_generation(
    *,
    provider: LLMProvider,
    model: str,
    orchestrator: AgentOrchestrator,
    session_id: UUID,
    workspace_root: str,
    target: str,
    max_attempts: int = 2,
) -> TestGenerationResult:
    framework = detect_framework(workspace_root)
    rootp = Path(workspace_root).resolve()
    target_path = (rootp / target).resolve()
    target_path.relative_to(rootp)
    source = target_path.read_text(encoding="utf-8") if target_path.is_file() else ""

    prompt = (
        f"Target file `{target}` (framework: {framework.name}).\n\n"
        f"Source:\n```\n{source}\n```\n\n"
        "Write a complete test file."
    )
    resp = await provider.chat(
        ChatRequest(
            messages=[ChatMessage(role="system", content=TEST_SYSTEM), ChatMessage(role="user", content=prompt)],
            model=model,
            temperature=0.1,
        )
    )
    test_source = _extract_code(resp.text)

    test_dir = rootp / "tests"
    test_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(target).stem
    if framework.suffix.startswith("."):
        test_file = test_dir / f"{stem}{framework.suffix}"
    else:
        test_file = test_dir / f"test_{stem}{framework.suffix}"
    test_file.write_text(test_source, encoding="utf-8")

    attempts = 0
    passed = False
    last_output: str | None = None
    while attempts < max_attempts:
        attempts += 1
        runner = list(framework.runner)
        runner_bin = runner[0]
        if not shutil.which(runner_bin):
            last_output = f"runner not available: {runner_bin}"
            break
        result = hotpath.pty_run(
            runner_bin,
            [*runner[1:], str(test_file.relative_to(rootp))],
            cwd=str(rootp),
            timeout_ms=60_000,
        )
        last_output = result.get("stdout", "")
        if result.get("exit_code") == 0:
            passed = True
            break
        # Ask the agent to repair the test file using its full tool set.
        await orchestrator.run(
            session_id=session_id,
            workspace_root=str(rootp),
            prompt=(
                f"The generated tests at `{test_file.relative_to(rootp)}` failed."
                f" Output:\n```\n{last_output[-2000:]}\n```\n"
                " Edit the test file (or the target) so the tests pass."
            ),
            config=OrchestratorConfig(max_repair_attempts=1),
        )
        test_source = test_file.read_text(encoding="utf-8") if test_file.exists() else test_source

    return TestGenerationResult(
        framework=framework.name,
        target=target,
        test_file=str(test_file.relative_to(rootp)),
        test_source=test_source,
        passed=passed,
        attempts=attempts,
        last_output=last_output,
    )


async def run_test_only(
    *,
    workspace_root: str,
    test_file: str,
    target: str = "",
    timeout_ms: int = 60_000,
) -> TestGenerationResult:
    """Re-execute an existing test file without regenerating it.

    Detects the framework, runs the runner against ``test_file`` once, and
    reports the refreshed ``passed`` / ``last_output``. Surfaces missing
    runners and timeouts inline via ``last_output`` rather than raising.
    """
    framework = detect_framework(workspace_root)
    rootp = Path(workspace_root).resolve()
    test_path = (rootp / test_file).resolve()
    # Guard against path traversal outside the workspace.
    test_path.relative_to(rootp)

    if not test_path.is_file():
        return TestGenerationResult(
            framework=framework.name,
            target=target,
            test_file=test_file,
            test_source="",
            passed=False,
            attempts=0,
            last_output=f"test file not found: {test_file}",
        )

    test_source = test_path.read_text(encoding="utf-8")
    runner = list(framework.runner)
    runner_bin = runner[0]
    if not shutil.which(runner_bin):
        return TestGenerationResult(
            framework=framework.name,
            target=target,
            test_file=test_file,
            test_source=test_source,
            passed=False,
            attempts=0,
            last_output=f"runner not available: {runner_bin}",
        )

    result = hotpath.pty_run(
        runner_bin,
        [*runner[1:], str(test_path.relative_to(rootp))],
        cwd=str(rootp),
        timeout_ms=timeout_ms,
    )
    last_output = result.get("stdout", "")
    if result.get("timed_out"):
        last_output = (last_output or "") + f"\ntest run timed out after {timeout_ms}ms"
    passed = result.get("exit_code") == 0

    return TestGenerationResult(
        framework=framework.name,
        target=target,
        test_file=test_file,
        test_source=test_source,
        passed=passed,
        attempts=1,
        last_output=last_output,
    )
