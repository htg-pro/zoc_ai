"""Contract-twin parity checks for Advanced Context Engine events."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from shared_schema.agent_events import ContextCompressedEvent, MapFilesEvent


def test_advanced_context_event_twins_are_generated_and_in_sync() -> None:
    root = Path(__file__).resolve().parents[3]
    generator = root / "packages/shared-types/scripts/generate_ts.py"
    completed = subprocess.run(
        [sys.executable, str(generator), "--check"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr

    assert {
        name: field.alias
        for name, field in MapFilesEvent.model_fields.items()
        if name in {"read_list", "write_list", "rationale"}
    } == {
        "read_list": "readList",
        "write_list": "writeList",
        "rationale": None,
    }
    assert {
        name: field.alias
        for name, field in ContextCompressedEvent.model_fields.items()
        if name
        in {"original_tokens", "compressed_tokens", "compression_ratio"}
    } == {
        "original_tokens": "originalTokens",
        "compressed_tokens": "compressedTokens",
        "compression_ratio": "compressionRatio",
    }

    typescript = (
        root / "packages/shared-types/typescript/src/agent-events.ts"
    ).read_text(encoding="utf-8")
    assert 'export interface MapFilesEvent extends BaseEvent {' in typescript
    assert 'type: "map-files";' in typescript
    assert "readList: string[];" in typescript
    assert "writeList: string[];" in typescript
    assert 'export interface ContextCompressedEvent extends BaseEvent {' in typescript
    assert 'type: "context-compressed";' in typescript
    assert "originalTokens: number;" in typescript
    assert "compressedTokens: number;" in typescript
    assert "compressionRatio: number;" in typescript
