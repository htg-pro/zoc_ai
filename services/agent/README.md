# `llama-studio-agent`

FastAPI sidecar. Bound to loopback only; the Tauri shell spawns it and
captures the port it announces on stdout (`LLAMA_STUDIO_AGENT_PORT=<n>`).

```bash
uv run llama-studio-agent          # picks a free port
LLAMA_STUDIO_PORT=8765 uv run llama-studio-agent
```

Phase 1 ships only `/health` and a stub `/v1/ping`. Real endpoints (sessions,
plans, tool calls, streaming) land in Phase 2.

## Workspace indexer embeddings

The indexer picks an embedding model at startup via
`llama_studio_agent.indexer.embeddings.resolve_embedder`:

| Situation | Embedder used |
| --- | --- |
| Local llama.cpp server is running with an embedding model (auto-detected) | llama.cpp `nomic-embed-text` (768-dim) — preferred when available |
| `LLAMA_STUDIO_OPENAI_API_KEY` set, no local llama.cpp embed model | OpenAI `text-embedding-3-small` (1536-dim) |
| `LLAMA_STUDIO_EMBEDDING_PROVIDER=openai` / `llamacpp` | Forces that provider; pin a model with `LLAMA_STUDIO_EMBEDDING_MODEL` |
| Nothing available | Deterministic hashed bag-of-tokens fallback — always works offline, modest quality |

The auto-detect path probes the local llama.cpp server at startup (`GET /v1/models`, 0.75s
timeout) and prefers a local model first so the default install is
zero-config: running llama-server with `nomic-embed-text.gguf` is all a user
needs to get real semantic search. `text-embedding-3-small` is the
chosen cloud default — the cheapest production-quality embedder OpenAI
ships.

Real-provider embedders are wrapped in a `ResilientEmbedder`: if the
provider fails at runtime (network outage, auth error), the indexer
permanently degrades to the hash fallback for that session and wipes
the now-stale vectors so cosine similarity stays meaningful.

The indexer records the active embedding signature (`provider:model:dim`)
in the vector store's `meta` table and clears the store automatically if
the signature changes between runs, so switching models never leaves
stale, dimension-mismatched vectors behind.
