"""Process-wide AppState: registries, persistence, event bus, indexers.

Held on `app.state.app_state` so dependency-injection helpers can fetch it
in a single place.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from threading import RLock
from uuid import UUID

from .agent.recall import MessageVectorStore, RecallService
from .approvals import ApprovalGate
from .commands import SlashCommandRegistry
from .commands import build_default_registry as build_command_registry
from .config import Settings
from .events import EventBus
from .indexer import IndexerService
from .indexer.embeddings import resolve_embedder
from .indexer.store import VectorStore
from .modes.terminal import TerminalAgent
from .permissions import PermissionManager
from .persistence import Database, SessionRepository
from .providers import ProviderRegistry
from .providers import build_default_registry as build_provider_registry
from .runs import RunRegistry
from .tools import ToolRegistry
from .tools import build_default_registry as build_tool_registry


@dataclass
class AppState:
    settings: Settings
    db: Database
    repo: SessionRepository
    bus: EventBus
    providers: ProviderRegistry
    tools: ToolRegistry
    commands: SlashCommandRegistry
    permissions: PermissionManager
    terminals: TerminalAgent
    recall: RecallService | None = None
    approvals: ApprovalGate = field(default_factory=ApprovalGate)
    runs: RunRegistry = field(default_factory=RunRegistry)
    _indexers: dict[UUID, IndexerService] = field(default_factory=dict)
    _index_lock: RLock = field(default_factory=RLock)

    def indexer_for(self, session_id: UUID, workspace_root: str) -> IndexerService:
        with self._index_lock:
            existing = self._indexers.get(session_id)
            if existing and existing.workspace_root == str(Path(workspace_root).resolve()):
                return existing
            store_path = Path(self.settings.data_dir) / "indexes" / f"{session_id}.sqlite3"
            embedder = resolve_embedder(self.settings, self.providers)
            indexer = IndexerService(
                workspace_root=workspace_root,
                store=VectorStore(store_path, dim=embedder.dim),
                embedder=embedder,
            )
            self._indexers[session_id] = indexer
            return indexer


def build_app_state(settings: Settings) -> AppState:
    db_path = Path(settings.data_dir) / settings.db_filename
    db = Database(db_path)
    repo = SessionRepository(db)
    providers = build_provider_registry(settings)
    # Phase 4: per-process recall store. Lives next to the main DB so it
    # shares the same backup/wipe lifecycle. The embedder is reused from
    # the workspace indexer's resolver so we degrade to the offline hash
    # embedder when no real one is configured.
    recall_store = MessageVectorStore(Path(settings.data_dir) / "recall.sqlite")
    recall_service = RecallService(
        store=recall_store,
        embedder=resolve_embedder(settings, providers),
    )
    return AppState(
        settings=settings,
        db=db,
        repo=repo,
        bus=EventBus(seq_floor=repo.max_event_seq),
        providers=providers,
        tools=build_tool_registry(),
        commands=build_command_registry(),
        permissions=PermissionManager(repo),
        terminals=TerminalAgent(),
        recall=recall_service,
        approvals=ApprovalGate(),
        runs=RunRegistry(),
    )
