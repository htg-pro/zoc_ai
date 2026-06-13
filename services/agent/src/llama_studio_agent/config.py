"""Settings (env-driven) for the agent sidecar."""

from __future__ import annotations

import json
import logging
import os
import shutil
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

_log = logging.getLogger(__name__)

SETTINGS_OVERRIDES_FILENAME = "settings.json"
# Subset of Settings fields the running app is allowed to mutate at runtime
# via the `/v1/settings` API. Anything outside this allow-list stays
# env-only (host, port, data_dir, API keys, etc.).
RUNTIME_MUTABLE_FIELDS: frozenset[str] = frozenset(
    {"embedding_provider", "embedding_model", "embedding_dim"}
)


def _default_data_dir() -> str:
    base = os.environ.get("LLAMA_STUDIO_DATA_DIR")
    if base:
        return base
    home = Path.home()
    return str(home / ".llama-studio")


def _default_hotpath_bin() -> str:
    explicit = os.environ.get("LLAMA_STUDIO_HOTPATH_BIN")
    if explicit:
        return explicit
    found = shutil.which("llama-studio-hotpath")
    if found:
        return found
    # Repo dev fallback: <repo>/target/release/llama-studio-hotpath.
    # When frozen by PyInstaller the module lives in a shallow temp dir, so
    # parents[4] is out of bounds — guard it and fall back to PATH lookup.
    try:
        repo_root = Path(__file__).resolve().parents[4]
    except IndexError:
        return "llama-studio-hotpath"
    for candidate in (
        repo_root / "target" / "release" / "llama-studio-hotpath",
        repo_root / "target" / "debug" / "llama-studio-hotpath",
    ):
        if candidate.exists():
            return str(candidate)
    return "llama-studio-hotpath"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="LLAMA_STUDIO_",
        env_file=".env",
        extra="ignore",
    )

    debug: bool = False
    host: str = "127.0.0.1"
    port: int = 0  # 0 → OS-assigned free port
    allowed_origins: list[str] = [
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "tauri://localhost",
        "https://tauri.localhost",
    ]

    # Storage
    data_dir: str = _default_data_dir()
    db_filename: str = "agent.sqlite3"
    index_filename: str = "index.sqlite3"

    # Hot-path Rust CLI
    hotpath_bin: str = _default_hotpath_bin()

    # Default provider/model: production defaults to the local llama.cpp
    # server. Tests can still override this with LLAMA_STUDIO_DEFAULT_PROVIDER=mock.
    default_provider: str = "llamacpp"
    default_model: str = "local"

    # Provider API keys (env): LLAMA_STUDIO_OPENAI_API_KEY etc.
    openai_api_key: str | None = None
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None
    llamacpp_base_url: str = "http://127.0.0.1:8080"
    llamacpp_state_path: str | None = None

    # Embedding selection for the workspace indexer.
    #   None / "auto" → pick OpenAI when LLAMA_STUDIO_OPENAI_API_KEY is set,
    #                  otherwise the deterministic hash fallback.
    #   "openai" | "llamacpp" | "mock" → force a provider.
    #   "hash" → force the offline hash embedder.
    embedding_provider: str | None = None
    embedding_model: str | None = None
    embedding_dim: int = 256  # only used by the hash fallback


def _overrides_path(data_dir: str) -> Path:
    return Path(data_dir) / SETTINGS_OVERRIDES_FILENAME


def load_runtime_overrides(data_dir: str) -> dict[str, object]:
    """Return persisted runtime overrides (from a prior PATCH /v1/settings)
    that should be re-applied on startup. Missing / malformed files yield
    an empty dict."""

    path = _overrides_path(data_dir)
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        _log.warning("settings: ignoring malformed overrides at %s (%s)", path, exc)
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if k in RUNTIME_MUTABLE_FIELDS}


def save_runtime_overrides(data_dir: str, overrides: dict[str, object]) -> None:
    """Persist the given runtime overrides to disk so they survive a
    process restart. Only fields in `RUNTIME_MUTABLE_FIELDS` are written."""

    filtered = {k: v for k, v in overrides.items() if k in RUNTIME_MUTABLE_FIELDS}
    path = _overrides_path(data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(filtered, indent=2, sort_keys=True), "utf-8")
    tmp.replace(path)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    cfg = Settings()
    Path(cfg.data_dir).mkdir(parents=True, exist_ok=True)
    for key, value in load_runtime_overrides(cfg.data_dir).items():
        try:
            setattr(cfg, key, value)
        except (ValueError, TypeError) as exc:
            _log.warning("settings: dropping invalid override %s=%r (%s)", key, value, exc)
    return cfg


def reset_settings_cache() -> None:
    """Test helper — drop the cached Settings so env changes take effect."""

    get_settings.cache_clear()
