# Zoc Studio — Full A-to-Z Development Prompt Guide

This document is the master development reference for Zoc Studio.
Every section contains precise prompts you can give to an AI coding agent
(or follow yourself) to build, extend, debug, or ship any part of the system.

---

## TABLE OF CONTENTS

1. [Project Overview](#1-project-overview)
2. [Architecture Map](#2-architecture-map)
3. [Dev Environment Setup](#3-dev-environment-setup)
4. [Desktop Shell (Rust / Tauri)](#4-desktop-shell-rust--tauri)
5. [Agent Gateway (Python / FastAPI)](#5-agent-gateway-python--fastapi)
6. [Frontend (React / TypeScript)](#6-frontend-react--typescript)
7. [LLM Integration (llama.cpp + Cloud)](#7-llm-integration-llamacpp--cloud)
8. [Agent Loop & FSM](#8-agent-loop--fsm)
9. [File System & Git Layer](#9-file-system--git-layer)
10. [Terminal / PTY Layer](#10-terminal--pty-layer)
11. [Editor (Monaco)](#11-editor-monaco)
12. [RAG / Context Engine](#12-rag--context-engine)
13. [Execution Budget & Safety Guards](#13-execution-budget--safety-guards)
14. [Session Diary & Memory](#14-session-diary--memory)
15. [UI Component System](#15-ui-component-system)
16. [Agent Panel UI/UX](#16-agent-panel-uiux)
17. [Model Picker & Provider Switching](#17-model-picker--provider-switching)
18. [Secrets & Settings](#18-secrets--settings)
19. [Testing Strategy](#19-testing-strategy)
20. [Build & Release Pipeline](#20-build--release-pipeline)
21. [Debugging Playbook](#21-debugging-playbook)
22. [Feature Backlog Prompts](#22-feature-backlog-prompts)

---

## 1. PROJECT OVERVIEW

**Zoc Studio** is a local-first AI coding desktop application.
The user opens a project folder, selects a local GGUF model (or a cloud model),
then talks to an autonomous coding agent that can read files, write code,
run terminal commands, and iterate until the task is done — all on the user's machine.

**Core promise:** Full reasoning loop, zero cloud lock-in. The LLM runs locally
via `llama.cpp`. The user keeps full control via an execution budget and an
approval gate for destructive actions.

**Tech stack at a glance:**

| Layer | Technology |
|---|---|
| Desktop shell | Rust + Tauri v2 |
| Agent gateway / sidecar | Python 3.12 + FastAPI |
| Frontend | React 18 + TypeScript + Vite + Tailwind CSS |
| Local LLM runtime | llama.cpp (`llama-server` binary) |
| Cloud LLM fallback | OpenAI / Anthropic (OpenAI-compatible API) |
| Editor | Monaco Editor |
| Terminal | xterm.js + OS PTY via Python sidecar |
| State management | Zustand |
| IPC | Tauri `invoke` + SSE (Server-Sent Events) |
| Monorepo | pnpm workspaces + Cargo workspace |

---

## 2. ARCHITECTURE MAP

```
┌──────────────────────────────────────────────────────────────────┐
│  Tauri Desktop App (apps/desktop — Rust)                         │
│                                                                  │
│  ┌─────────────────────────────────────────────┐                 │
│  │  WebView  (apps/frontend — React/TS)        │                 │
│  │  • Monaco editor   • Agent panel            │                 │
│  │  • File explorer   • Terminal (xterm.js)    │                 │
│  │  • Model picker    • Settings               │                 │
│  └──────────────┬──────────────────────────────┘                 │
│                 │ Tauri IPC (invoke / emit)                      │
│  ┌──────────────▼──────────────────────────────┐                 │
│  │  Rust Shell                                 │                 │
│  │  • Sidecar supervisor (sidecar.rs)          │                 │
│  │  • llama-server supervisor (llama_server.rs)│                 │
│  │  • Workspace FS + Git (fs_commands.rs)      │                 │
│  │  • Patch applicator (patch.rs)              │                 │
│  │  • Secrets vault (secrets.rs)               │                 │
│  └──────────────┬──────────────────────────────┘                 │
│                 │ spawn (stdin/stdout handshake)                  │
│  ┌──────────────▼──────────────────────────────┐                 │
│  │  Python Agent Gateway (services/gateway)    │                 │
│  │  • FastAPI HTTP + SSE                       │                 │
│  │  • Orchestrator + FSM                       │                 │
│  │  • RAG / context engine                     │                 │
│  │  • Memory matrix + diary worker             │                 │
│  │  • Tool executor (files, terminal, search)  │                 │
│  └──────────────┬──────────────────────────────┘                 │
│                 │ HTTP (OpenAI-compatible)                        │
│  ┌──────────────▼──────────────────────────────┐                 │
│  │  llama-server  (llama.cpp binary)           │                 │
│  │  OR  cloud API (OpenAI / Anthropic)         │                 │
└──┴─────────────────────────────────────────────┴─────────────────┘
```

**Data flow for an agent run:**

1. User types in Composer → `POST /v1/agent/run` → Python gateway
2. Gateway FSM transitions: INIT → PLAN → APPLY → VERIFY → DONE
3. Each FSM stage emits events onto `GET /v1/agent/events` (SSE stream)
4. Frontend `useAgentStream.ts` consumes events → Zustand store → UI renders
5. File writes / patches: gateway calls Tauri IPC `apply_patch` → Rust writes disk
6. Approval-required actions: gateway emits `decision_required` event → user clicks → `POST /v1/agent/decision`

---

## 3. DEV ENVIRONMENT SETUP

### 3.1 Prerequisites

```
Prompt: "Set up the Zoc Studio development environment from scratch.
Install Rust (stable), Node.js 20, Python 3.12, pnpm, and the
llama.cpp server binary. Configure the Tauri v2 CLI. Verify each
tool is on PATH. Document any OS-specific steps for macOS, Linux,
and Windows."
```

**Manual steps:**
```bash
# Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add aarch64-apple-darwin x86_64-apple-darwin  # macOS universal

# Node + pnpm
nvm install 20 && npm i -g pnpm@9

# Python
python3.12 -m venv .venv && source .venv/bin/activate
pip install uv && uv sync

# Frontend deps
pnpm install

# Tauri CLI
cargo install tauri-cli --version "^2"
```

### 3.2 Starting the Dev Server (Replit / CI)

```
Prompt: "The vitest package is blocked by the Replit firewall. Create a
bootstrap script at scripts/setup-frontend-dev.sh that manually symlinks
every required package from the pnpm content-addressable store into
apps/frontend/node_modules/, then launches vite on port 5000 at 0.0.0.0.
Do NOT call pnpm install — use symlinks only."
```

The working script is at `scripts/setup-frontend-dev.sh`.
Run it once; after that the workflow restarts it automatically.

### 3.3 Running all services locally

```
Prompt: "Add a Makefile target 'dev' that:
1. Starts the Python gateway with uvicorn on a random port and prints
   'ZOC_STUDIO_AGENT_PORT=<port>' to stdout.
2. Starts vite (apps/frontend) on port 5000.
3. Opens the Tauri dev window that loads http://localhost:5000.
All three processes must share a single terminal via a process group so
Ctrl+C kills them all."
```

---

## 4. DESKTOP SHELL (RUST / TAURI)

### 4.1 Sidecar Supervisor

**File:** `apps/desktop/src/sidecar.rs`

```
Prompt: "The sidecar supervisor must:
- Spawn the Python gateway as a sidecar binary (bundled with the app).
- Read stdout line by line; when a line matches 'ZOC_STUDIO_AGENT_PORT=<N>'
  extract the port number and store it in an Arc<Mutex<AgentStatus>>.
- If the process exits with a non-zero code, restart it after a 2-second
  back-off (max 5 retries). On the 5th failure emit an 'agent://status'
  event with status='crashed'.
- Expose a Tauri command 'agent_port() -> Option<u16>' so the frontend
  can discover the port.
- Expose 'agent_status() -> AgentStatus' that returns { status, port,
  restart_count }."
```

### 4.2 LLM Server Supervisor

**File:** `apps/desktop/src/llama_server.rs`

```
Prompt: "The LlamaServerSupervisor must:
- Accept a struct LlamaConfig { model_path: PathBuf, context_size: u32,
  gpu_layers: i32, host: String, port: u16 }.
- Spawn 'llama-server' with the correct CLI flags derived from config.
- Monitor stdout for 'HTTP server listening' to mark the server as ready.
- Expose Tauri commands: start_llama_server(config), stop_llama_server(),
  llama_server_status() -> LlamaStatus { Stopped | Starting | Ready | Error }.
- On model swap: stop the old process, wait for it to exit (with 5s timeout),
  then start with the new config."
```

### 4.3 Filesystem Commands

**File:** `apps/desktop/src/fs_commands.rs`

```
Prompt: "All filesystem commands must be workspace-locked — they must
reject any path that escapes the user-selected workspace root (prevent
path traversal). Implement:
- read_file(path) -> Result<String>
- write_file(path, content) -> Result<()>
- list_dir(path) -> Result<Vec<DirEntry>>  // includes type + size + mtime
- create_dir(path) -> Result<()>
- delete_path(path) -> Result<()>          // files + directories (recursive)
- rename_path(old, new) -> Result<()>
- watch_workspace(root) -> starts a debounced notify watcher that emits
  'fs://changed' events to the frontend with { path, kind }

All errors must include the attempted path in the error message."
```

### 4.4 Patch Applicator

**File:** `apps/desktop/src/patch.rs`

```
Prompt: "Implement apply_patch(unified_diff: String) -> Result<PatchResult>:
- Parse a standard unified diff (--- a/file +++ b/file @@ ... format).
- For each hunk, verify the 'before' lines match the file on disk before
  writing. If any hunk fails to match, return Err with the first failing
  hunk's context line and do NOT write any file.
- If all hunks match, apply all file writes atomically using a temp-file +
  rename strategy so the file is never in a half-written state.
- Return PatchResult { files_changed: Vec<String>, lines_added: u32,
  lines_removed: u32 }."
```

### 4.5 Git Integration

**File:** `apps/desktop/src/git.rs`

```
Prompt: "Implement these Tauri commands backed by the 'git2' crate:
- git_status() -> Vec<GitStatusEntry> { path, status_code }
- git_diff(path) -> String   // unified diff of unstaged changes
- git_commit(message) -> Result<String>  // returns new commit SHA
- git_log(limit: u32) -> Vec<CommitInfo>
- git_branch_list() -> Vec<String>
- git_checkout_branch(name) -> Result<()>
- git_create_branch(name) -> Result<()>
All operations must be scoped to the current workspace root."
```

### 4.6 Secrets Vault

**File:** `apps/desktop/src/secrets.rs`

```
Prompt: "Store API keys using the OS keychain (keyring crate).
Implement Tauri commands:
- set_secret(key: String, value: String) -> Result<()>
- get_secret(key: String) -> Result<Option<String>>
- delete_secret(key: String) -> Result<()>
- list_secret_keys() -> Vec<String>  // keys only, never values
Keys must be namespaced under 'zoc-studio/<key>' in the keychain.
Never log or return secret values in error messages."
```

---

## 5. AGENT GATEWAY (PYTHON / FASTAPI)

**Directory:** `services/gateway/`

### 5.1 Application Bootstrap

```
Prompt: "The gateway is a FastAPI app launched as a Tauri sidecar.
On startup it must:
1. Bind to a random available port on 127.0.0.1.
2. Print exactly 'ZOC_STUDIO_AGENT_PORT=<port>' to stdout so the Rust
   supervisor can discover it.
3. Expose CORS only for 'tauri://localhost' and 'http://localhost:*'.
4. Register routers: /v1/agent, /v1/terminal, /v1/models, /v1/workspace.
5. On shutdown, cancel all running agent tasks and close all PTY sessions."
```

### 5.2 Run Control Endpoints

```
Prompt: "Implement these HTTP endpoints in services/gateway/routes/agent.py:

POST /v1/agent/run
  Body: { task: str, mode: 'ask'|'agent', model_id: str, budget: BudgetConfig }
  Returns: { run_id: str }
  Side-effect: starts the agent FSM loop in a background asyncio task.

POST /v1/agent/decision
  Body: { run_id: str, decision: 'approve'|'reject', reason?: str }
  Returns: 204
  Side-effect: unblocks the FSM that is waiting for user approval.

DELETE /v1/agent/run/{run_id}
  Cancels and cleans up a running or paused run.

GET /v1/agent/runs
  Returns: list of all active run IDs and their FSM states."
```

### 5.3 SSE Event Stream

```
Prompt: "Implement GET /v1/agent/events?run_id=<id> as a Server-Sent Events
endpoint. It must:
- Stream events as they are produced by the agent FSM.
- Each event is JSON: { seq: int, type: EventType, payload: object }.
- Event types: thinking, tool_call, tool_result, file_edit, terminal_output,
  decision_required, progress, done, error.
- On client disconnect, stop yielding but do NOT cancel the agent run.
- Include a 'retry: 1000' SSE field so clients auto-reconnect.
- Events must be emitted in strictly increasing seq order.
- Buffer up to 512 events per run so a reconnecting client can replay
  missed events by passing ?since_seq=<N>."
```

---

## 6. FRONTEND (REACT / TYPESCRIPT)

### 6.1 Project Structure

```
apps/frontend/src/
  App.tsx                   # root — just renders <Shell />
  main.tsx                  # Tauri + React bootstrap
  types.ts                  # shared frontend types
  lib/
    store.ts                # Zustand root store
    agent-client.ts         # gateway HTTP client
    tauri-client.ts         # Tauri IPC wrappers
    providers.ts            # model provider config
  features/
    agent/                  # agent panel (chat + runs)
    editor/                 # Monaco editor view
    files/                  # file explorer + tree
    terminal/               # xterm.js integration
    scm/                    # git status + diff
    settings/               # model + secrets settings
    search/                 # workspace search
    problems/               # diagnostics panel
  components/
    layout/
      Shell.tsx             # root layout (panels + resize)
    ui/                     # shadcn/ui primitives
```

### 6.2 Zustand Store Structure

```
Prompt: "Design the Zustand root store in src/lib/store.ts.
The store must have these slices:
- workspace: { root: string|null, files: FileTree }
- editor:    { openFiles: Tab[], activeFile: string|null, decorations }
- agent:     { runs: Map<string, AgentRun>, activeRunId: string|null }
- terminal:  { sessions: Map<string, TermSession> }
- models:    { available: Model[], active: Model|null }
- ui:        { sidebarWidth, panelSizes, theme }

Each slice must be a separate file in src/lib/slices/ and combined
in store.ts. Provide typed selectors for every slice so components
never read from the raw store object directly."
```

### 6.3 Gateway Client

```
Prompt: "Implement src/lib/agent-client.ts:
- startRun(task, mode, modelId, budget) -> Promise<{ runId }>
- streamEvents(runId, sinceSeq, onEvent) -> () => void  // returns unsub fn
- postDecision(runId, decision, reason?) -> Promise<void>
- cancelRun(runId) -> Promise<void>

The streamEvents function must use the native EventSource API, parse each
JSON payload, and call onEvent(event). On error, it must retry with
exponential back-off (1s, 2s, 4s, max 30s). It must accept a sinceSeq
parameter so reconnects replay missed events."
```

---

## 7. LLM INTEGRATION (llama.cpp + Cloud)

### 7.1 Model Runtime

```
Prompt: "Implement services/gateway/model_runtime.py:
- ModelRuntime class with async method complete(messages, tools, stream).
- It wraps the OpenAI Python client in streaming mode.
- For local models: base_url = 'http://127.0.0.1:<llama_port>/v1',
  api_key = 'local-no-key'.
- For cloud models: base_url from provider config, api_key from env.
- Tool calling: pass tools array in OpenAI function-calling format.
  Parse tool_calls from the streaming delta chunks and yield them as
  ToolCallChunk events.
- On rate-limit (429): retry with 5s exponential back-off, max 3 times.
- On connection error: raise ModelUnavailableError with a user-friendly
  message explaining how to restart llama-server."
```

### 7.2 Model Interface Contract

```
Prompt: "Define a strict interface in services/gateway/model_interface.py:

class ModelInterface(Protocol):
    async def complete(
        self,
        system_prompt: str,
        messages: list[Message],
        tools: list[Tool] | None = None,
        temperature: float = 0.2,
        max_tokens: int = 4096,
    ) -> AsyncIterator[ContentChunk | ToolCallChunk | DoneChunk]: ...

All LLM calls in the codebase must go through this interface.
No direct httpx or openai calls outside model_runtime.py."
```

### 7.3 Local Model Configuration

```
Prompt: "Add a model config schema in packages/shared-types that covers
both local (GGUF) and cloud models:

type Model = LocalModel | CloudModel

interface LocalModel {
  id: string;       // e.g. 'llama-3.1-8b-q4'
  kind: 'local';
  displayName: string;
  path: string;     // absolute path to .gguf file
  contextSize: number;
  gpuLayers: number;  // -1 = all, 0 = CPU only
}

interface CloudModel {
  id: string;       // e.g. 'gpt-4o'
  kind: 'cloud';
  provider: 'openai' | 'anthropic';
  displayName: string;
  contextSize: number;
  requiresKey: string;  // env var name holding the API key
}

Expose this type to both the Python gateway (via code-gen script
packages/shared-types/scripts/generate_ts.py) and the Rust shell."
```

---

## 8. AGENT LOOP & FSM

### 8.1 FSM States and Transitions

```
Prompt: "Implement the agent FSM in services/gateway/fsm.py.
States: IDLE → INITIALIZING → PLANNING → APPLYING → VERIFYING →
        WAITING_DECISION → DONE | ERROR | CANCELLED

Transitions:
  INITIALIZING → PLANNING       (always, after context is built)
  PLANNING     → APPLYING       (when LLM returns a non-empty plan)
  PLANNING     → DONE           (when LLM says task is complete)
  APPLYING     → VERIFYING      (after all edits applied)
  APPLYING     → WAITING_DECISION (when a destructive op needs approval)
  VERIFYING    → PLANNING       (when tests fail — re-plan)
  VERIFYING    → DONE           (when verification passes)
  Any state    → ERROR          (on unhandled exception)
  Any state    → CANCELLED      (on user cancel or budget exhaustion)

Each transition must emit a 'progress' SSE event with the new state name
and a human-readable description."
```

### 8.2 Orchestrator

```
Prompt: "Implement the orchestrator in services/gateway/orchestrator.py.
It wraps the FSM and enforces:
1. Budget ceiling: if token usage exceeds budget.max_tokens, pause and
   emit a 'decision_required' event asking the user to continue or stop.
2. Iteration limit: if the PLANNING → APPLYING → VERIFYING cycle repeats
   more than budget.max_iterations times, halt with a clear explanation.
3. Error recovery: if VERIFYING fails, re-enter PLANNING with the error
   context injected into the next LLM call. Limit to budget.max_recoveries.
4. On each tool call, check if it modifies files outside the workspace root.
   If yes, emit 'decision_required' before executing."
```

### 8.3 Toolsets

```
Prompt: "Implement the agent's toolset in services/gateway/toolsets.py.
Tools the agent can call:

read_file(path) -> str
write_file(path, content) -> { lines_written: int }
list_directory(path) -> [{ name, type, size }]
search_workspace(query, file_pattern?) -> [{ path, line, snippet }]
run_command(cmd, cwd?, timeout_s?) -> { stdout, stderr, exit_code }
create_file(path, content) -> { created: bool }
delete_file(path) -> { deleted: bool }
replace_in_file(path, old_text, new_text) -> { replacements: int }
fetch_url(url) -> { content: str }   // read-only, for docs

Each tool must:
- Validate inputs with pydantic.
- Log the call start + result to the DiaryWorker.
- Emit a 'tool_call' SSE event before executing.
- Emit a 'tool_result' SSE event after executing.
- Never execute shell commands that start with 'rm -rf /'.
- Enforce workspace-root confinement on all path parameters."
```

### 8.4 System Prompt Engineering

```
Prompt: "Write the system prompt for the Zoc Studio coding agent.
It must:
1. Establish the agent's identity: senior software engineer, methodical,
   never guesses, always reads before writing.
2. Explain available tools and when to use each one.
3. Define the planning format: the agent must output a JSON plan block
   BEFORE any tool calls. Format: { steps: [{ action, file, rationale }] }
4. Instruct the agent to verify its work: after writing files, run the
   project's test command or build command if one can be inferred.
5. Define the done signal: output exactly '<DONE>' on its own line when
   the task is complete and verified.
6. Limit response length: no prose longer than 3 sentences; use tool
   calls instead of describing what it's about to do."
```

---

## 9. FILE SYSTEM & GIT LAYER

### 9.1 File Explorer (Frontend)

```
Prompt: "Build the file explorer feature at apps/frontend/src/features/files/.
It must:
- Display a tree of the workspace root fetched via Tauri 'list_dir' command.
- Expand/collapse directories lazily (only fetch children when expanded).
- Show file status badges from git_status (M = modified, A = added, ? = untracked).
- Support right-click context menu: New File, New Folder, Rename, Delete,
  Copy Path, Reveal in Finder.
- Highlight the currently active editor file.
- Update in real-time via 'fs://changed' Tauri events without a full refresh.
- Keyboard navigation: arrow keys to move, Enter to open, Delete to trash."
```

### 9.2 Git Panel

```
Prompt: "Build the SCM (source control) panel at apps/frontend/src/features/scm/.
Show:
- Branch name with a dropdown to switch/create branches.
- List of changed files grouped by status (staged / unstaged / untracked).
- Click a file to open its unified diff in the editor.
- Inline commit message input + Commit button that calls git_commit.
- Refresh on 'fs://changed' events (debounced 500ms)."
```

---

## 10. TERMINAL / PTY LAYER

### 10.1 Python PTY Server

```
Prompt: "Implement PTY management in services/gateway/routes/terminal.py.

POST /v1/terminal/sessions
  Body: { shell?: str, cwd?: str }
  Returns: { session_id: str }
  Side-effect: spawns a PTY process using the 'ptyprocess' library.

POST /v1/terminal/sessions/{id}/input
  Body: { data: str }   // raw bytes, base64-encoded
  Returns: 204

GET /v1/terminal/sessions/{id}/output  (SSE)
  Streams raw PTY output as base64-encoded data events.

DELETE /v1/terminal/sessions/{id}
  Sends SIGTERM then SIGHUP to the PTY process, then removes the session.

POST /v1/terminal/sessions/{id}/resize
  Body: { cols: int, rows: int }
  Calls ptyprocess.setwinsize."
```

### 10.2 xterm.js Integration (Frontend)

```
Prompt: "Implement src/features/terminal/TerminalView.tsx.
It must:
- Create an xterm.js Terminal instance with FitAddon and WebLinksAddon.
- Connect to the gateway PTY session: stream output via SSE, send input
  via POST on xterm's 'data' event.
- Auto-resize the PTY when the container resizes (ResizeObserver +
  FitAddon.fit() + POST /v1/terminal/sessions/{id}/resize).
- Support multiple terminal tabs via session_id switching.
- Preserve scrollback when switching tabs.
- Apply the app's dark theme to xterm: background #0d0d10, cursor #7c6af7."
```

---

## 11. EDITOR (MONACO)

### 11.1 Monaco Setup

```
Prompt: "Set up Monaco Editor in src/features/editor/MonacoView.tsx.
Requirements:
- Use @monaco-editor/react with a custom dark theme matching the app palette
  (background #0d0d10, line highlight #161620, selection #2a2060).
- Auto-detect language from file extension.
- Disable minimap on panes narrower than 600px.
- Save on Cmd/Ctrl+S via an editor action that calls Tauri write_file.
- Show unsaved indicator (dot on tab) when buffer differs from disk.
- Accept changes from the agent: when the agent writes a file, reload the
  buffer without losing cursor position if the user has not made edits."
```

### 11.2 Inline Diff View

```
Prompt: "Implement InlineDiffView.tsx for showing agent-proposed changes
before they are applied.
It must:
- Accept { originalContent: string, proposedContent: string, filePath: string }.
- Use Monaco's createDiffEditor to show side-by-side or inline diff.
- Show 'Accept' and 'Reject' buttons that post a decision to the gateway.
- Highlight added lines green (#1a3a1a) and removed lines red (#3a1a1a).
- Show the file path and number of additions/deletions in the header."
```

---

## 12. RAG / CONTEXT ENGINE

```
Prompt: "Implement the RAG context engine in services/gateway/rag.py.
It must:
- Index all text files in the workspace using a simple inverted index
  (no external vector DB — use BM25 or TF-IDF for relevance scoring).
- On each LLM call, RAGMatcher.select_context(task, max_tokens=4096)
  returns the most relevant file snippets that fit within the token budget.
- Scoring factors: keyword overlap with the task, recently modified files
  (mtime), files already mentioned in the current conversation.
- Update the index incrementally when 'fs://changed' events arrive.
- Expose match_context(query) -> list[{ path, snippet, score }] for
  the agent toolset's search_workspace tool to call."
```

---

## 13. EXECUTION BUDGET & SAFETY GUARDS

```
Prompt: "Implement the budget system in services/gateway/budget.py.

BudgetConfig:
  max_tokens: int = 100_000      # total LLM tokens for the run
  max_iterations: int = 20       # plan-apply-verify cycles
  max_recoveries: int = 3        # error recovery attempts
  require_approval_for_delete: bool = True
  require_approval_for_shell: bool = False  # prompt engineering handles it

BudgetLedger tracks:
  tokens_used: int
  iterations: int
  recoveries: int
  start_time: datetime

BudgetLedger.check() raises BudgetExhaustedError (which the orchestrator
catches and converts to a 'decision_required' event) when any limit is hit.

The frontend must show a live budget meter in the agent panel header:
  tokens: used/max | iterations: N/20 | recoveries: N/3"
```

---

## 14. SESSION DIARY & MEMORY

```
Prompt: "Implement DiaryWorker in services/gateway/diary.py.
The diary is a per-session append-only log of every agent action.

Entry schema:
  { seq, timestamp, type, run_id, payload }
  type ∈ { llm_call, tool_call, tool_result, decision, error, state_change }

Storage:
- Write to ~/.zoc-studio/diaries/<workspace_hash>/<date>.jsonl
- One JSON object per line, flushed after each write.

MemoryMatrix:
- Load the last 20 diary entries on session start to give the agent
  continuity across restarts.
- On new session: inject a 'previous session context' block into the
  system prompt summarising the last diary entries via a brief LLM call."
```

---

## 15. UI COMPONENT SYSTEM

### 15.1 Design Tokens

```
Prompt: "Define the Zoc Studio design token system in
apps/frontend/src/styles/globals.css.
Color palette (dark theme only — no light mode):
  --zoc-bg:        #0d0d10   (app background)
  --zoc-surface:   #111115   (panel background)
  --zoc-border:    #1e1e2a   (borders)
  --zoc-text:      #e4e4ef   (primary text)
  --zoc-muted:     #6b6b80   (secondary text)
  --zoc-ember:     #7c6af7   (agent / brand purple)
  --zoc-agent:     #7c6af7   (agent accent = ember)
  --zoc-info:      #4a9eff   (informational blue)
  --zoc-success:   #3ecf8e   (success green)
  --zoc-error:     #f87171   (error red)
  --zoc-warning:   #fb923c   (warning orange)

Animations:
  animate-fade-row     — 200ms fade-in + translate-y for list rows
  animate-typing-dot   — pulsing dot for typing indicator
  animate-spin-slow    — 2s linear infinite spin for loading states
  zoc-check-pop        — scale(0) → scale(1) spring for checkmarks"
```

### 15.2 Shadcn Component Extensions

```
Prompt: "Audit all shadcn/ui components in src/components/ui/ and
apply the Zoc design tokens:
- All backgrounds must use var(--zoc-surface), not zinc/gray.
- All ring/focus colors must use var(--zoc-ember).
- Dialog overlays: bg-black/60 with backdrop-blur-sm.
- Scrollbars: thin, --zoc-border colored thumb.
Create a src/components/ui/index.ts barrel export for all components."
```

---

## 16. AGENT PANEL UI/UX

### 16.1 AgentPanel Layout

**File:** `apps/frontend/src/features/agent/AgentPanel.tsx`

```
Prompt: "Redesign AgentPanel.tsx to Cursor AI quality:
- Header: brand icon + 'Zoc Agent' title + mode badge + 'Select model'
  dropdown. Right side: stop button (only when running), kebab menu.
- Body: RunRegion.tsx fills remaining height with a virtualized scroll.
  Auto-scroll to bottom on new events. Scroll-to-bottom button appears
  when user has scrolled up.
- Footer: Composer.tsx is always pinned to bottom.
- Empty state (no runs): large centered icon + 'Start a task' heading +
  two bullet hints.
- Running state: show live token/iteration budget meter in header."
```

### 16.2 Message & Event Rendering

**File:** `apps/frontend/src/features/agent/rows.tsx`

```
Prompt: "Render the agent event stream as a timeline feed.
Each row type:
  thinking      → left-aligned dot + italic gray text, animated while streaming
  tool_call     → left timeline icon (tool-specific) + pill badge + collapsible args
  tool_result   → indented under tool_call, green/red border by exit_code
  file_edit     → file icon + path + '+N -M' diff stat badge, expandable diff block
  terminal_output → terminal icon + monospace text block (max 20 lines, scroll for more)
  decision_required → amber bordered card with Approve/Reject buttons
  progress      → state transition label in muted gray
  done          → green checkmark + duration + token count
  error         → red bordered card + error message + optional stack trace toggle"
```

### 16.3 Composer

**File:** `apps/frontend/src/features/agent/Composer.tsx`

```
Prompt: "Build the Composer input component.
Features:
- Textarea that auto-grows from 1 to 8 lines, then scrolls.
- Ask / Agent mode toggle pill (Ask = blue, Agent = purple).
- Autonomy level selector: Low / Medium / High (maps to budget presets).
- @ mentions: type '@' to open a file picker that inserts @filename tokens.
- / commands: type '/' to show a command palette (e.g. /explain, /test, /fix).
- Attachment button: opens file picker, attaches file content to the message.
- Send button: arrow-up icon, glows with --zoc-ember when text is non-empty.
- Keyboard: Enter sends, Shift+Enter adds newline, Escape clears.
- Disabled + spinner state while a run is in progress."
```

### 16.4 Tool Call Cards

**File:** `apps/frontend/src/features/agent/ToolCallCard.tsx`

```
Prompt: "Build ToolCallCard.tsx for rendering a single tool call + result pair.
Layout:
- Header row: icon for tool type + tool name + status badge (running/done/error)
  + duration ms + collapse chevron.
- Collapsed (default): show one-line summary (e.g. 'read_file apps/foo.ts').
- Expanded: show full args as a syntax-highlighted JSON block and the result
  (truncated to 500 chars with 'show more' toggle).
- Color coding: read ops = blue left border, write ops = amber, run = green,
  error = red.
- Animate entry with animate-fade-row."
```

### 16.5 Run Trace Card

**File:** `apps/frontend/src/features/agent/RunTraceCard.tsx`

```
Prompt: "Build RunTraceCard.tsx — the collapsible container for a full agent run.
It wraps all events for one run_id.
Header: run number badge + first-line task summary (truncated 60 chars)
        + FSM state badge + elapsed time + collapse chevron.
Body: the list of Row components from rows.tsx.
States:
  running  → spinning loader in header, amber state badge
  done     → green checkmark, 'Done in Xs · N tokens'
  error    → red X badge + error summary
  cancelled → gray X badge
Auto-expand the most recent run; collapse older runs by default."
```

---

## 17. MODEL PICKER & PROVIDER SWITCHING

```
Prompt: "Build the model picker in src/features/settings/ModelPicker.tsx.
It must:
- List all models from the Zustand models slice.
- Group them: 'Local Models' (GGUF) and 'Cloud Models'.
- For each local model, show: name, size on disk, context window, GPU/CPU badge.
- For cloud models, show: name, provider logo, context window, API key status
  (green check if key is set, red lock if missing).
- 'Add local model' button: opens a file picker filtered to *.gguf, then
  calls Tauri start_llama_server with the chosen file.
- Switching models: calls stop_llama_server() then start_llama_server() with
  a loading transition in the UI.
- Persist the active model choice to localStorage."
```

---

## 18. SECRETS & SETTINGS

```
Prompt: "Build the settings panel at src/features/settings/SettingsPanel.tsx.
Sections:
  API Keys:
    - OpenAI API Key (masked input + test button that calls /v1/models)
    - Anthropic API Key
    - Keys stored via Tauri set_secret / get_secret — never in localStorage.
  Agent Defaults:
    - Default mode: Ask / Agent
    - Default autonomy: Low / Medium / High
    - Max tokens budget slider (10k – 500k)
    - Max iterations (5 – 50)
  Editor:
    - Font size (12–20)
    - Tab size (2/4)
    - Word wrap toggle
  Telemetry:
    - Anonymous usage stats toggle (off by default)
    - 'Delete all session diaries' danger button"
```

---

## 19. TESTING STRATEGY

### 19.1 Python Gateway Tests

```
Prompt: "The gateway test suite at services/gateway/tests/ uses pytest +
hypothesis for property-based tests. Follow these rules:
1. Every FSM transition must have a unit test that verifies the correct
   next state and the correct SSE events emitted.
2. Every tool must have a test with a real temp directory (not mocks) that
   verifies the actual file system effect.
3. Budget exhaustion must have a property test: for any sequence of LLM
   calls whose total tokens exceeds max_tokens, BudgetExhaustedError is
   always raised before the next LLM call.
4. The SSE event seq numbers must be strictly increasing — test this as
   a property over any sequence of ≥2 events."
```

### 19.2 Rust Tests

```
Prompt: "Write Rust unit tests for:
- patch.rs: given a known file content and a valid unified diff,
  apply_patch must produce the correct output. Also test that a diff
  with wrong context lines returns Err without modifying any files.
- workspace.rs: path traversal attempts (../../etc/passwd) must always
  return Err.
- llama_server.rs: test the port extraction regex against sample stdout."
```

### 19.3 Frontend Component Tests

```
Prompt: "Write React Testing Library tests for:
- Composer.tsx: test that pressing Enter calls startRun, Shift+Enter adds
  a newline, and the send button is disabled when text is empty.
- rows.tsx: for each row type, render with mock data and assert the correct
  icon, text, and accessibility role is present.
- AgentPanel.tsx: test empty state renders, that a 'done' run shows the
  green checkmark, and that a 'decision_required' event renders Approve/
  Reject buttons."
```

---

## 20. BUILD & RELEASE PIPELINE

### 20.1 Tauri Production Build

```
Prompt: "The production build must:
1. Run 'pnpm build' in apps/frontend to produce apps/frontend/dist/.
2. Bundle the Python gateway as a standalone binary using PyInstaller.
   Command: pyinstaller --onefile --name zoc-gateway services/gateway/main.py
   Output goes to apps/desktop/src-tauri/binaries/zoc-gateway-<target>.
3. Bundle the llama-server binary into apps/desktop/src-tauri/binaries/.
4. Run 'cargo tauri build' which produces platform installers in
   apps/desktop/src-tauri/target/release/bundle/.
Write a Makefile target 'release' that runs all four steps in order
and prints a summary of the output artifacts."
```

### 20.2 Version Stamping

```
Prompt: "The VERSION file at the repo root contains the semver string (e.g. 1.2.0).
The stamp_version.py script must propagate this to:
- apps/desktop/src-tauri/tauri.conf.json → version field
- apps/frontend/package.json → version field
- services/gateway/version.py → __version__ = '1.2.0'
Run stamp_version.py as the first step in the release Makefile target."
```

---

## 21. DEBUGGING PLAYBOOK

### 21.1 Sidecar Not Starting

```
Prompt: "The agent panel shows 'Offline'. Debug steps:
1. Check the Tauri window console for 'agent://status' events.
2. In the Rust shell, add logging to sidecar.rs: log every stdout line
   from the Python process until the port handshake succeeds.
3. Run the Python gateway manually:
   python services/gateway/main.py
   and verify it prints 'ZOC_STUDIO_AGENT_PORT=XXXX'.
4. If it crashes on import, run:
   python -c 'import services.gateway.app'
   and fix the import error.
5. Check that the binary path in tauri.conf.json externalBin matches the
   PyInstaller output exactly (including target triple suffix)."
```

### 21.2 llama-server Not Responding

```
Prompt: "The model picker shows 'Starting...' indefinitely. Debug steps:
1. Check llama_server.rs logs: grep for 'HTTP server listening' in the
   captured stdout buffer.
2. Check that the GGUF file path is valid and the file is not corrupted:
   run 'llama-server --model <path> --check' (if supported).
3. Verify GPU layers: if gpuLayers > 0 but CUDA/Metal is not available,
   llama-server will fail. Set gpuLayers = 0 as a fallback.
4. Check port conflict: the supervisor picks the port; ensure nothing else
   is bound to it with 'lsof -i :<port>'.
5. Memory: a 7B Q4 model needs ~4GB RAM. Check available memory."
```

### 21.3 SSE Stream Disconnects

```
Prompt: "The agent panel freezes mid-run. Debug steps:
1. Open browser DevTools → Network → filter by 'events'. Check if the
   SSE connection is still open (status 200, type EventStream).
2. If disconnected: check the Python gateway logs for any unhandled
   exception in the SSE generator coroutine.
3. Add a heartbeat: every 15s emit a ':keepalive\n\n' SSE comment from
   the gateway to prevent proxy timeouts.
4. Check that the frontend EventSource has an 'onerror' handler that
   reconnects with sinceSeq set to the last received seq number."
```

### 21.4 Vite Dev Server Can't Resolve Packages (Replit)

```
Prompt: "pnpm install fails with ERR_PNPM_FETCH_403 on vitest.
Do NOT retry pnpm install. Instead:
1. Check which packages fail to resolve at runtime with vite:
   grep the vite output for 'Failed to resolve import'.
2. For each missing package, find its directory in node_modules/.pnpm/:
   ls node_modules/.pnpm/ | grep '<package-name>'
3. Add a symlink in apps/frontend/node_modules/ pointing to the store path:
   ln -sfn $(pwd)/node_modules/.pnpm/<exact-dir>/node_modules/<pkg> apps/frontend/node_modules/<pkg>
4. Restart the vite server. Repeat until all imports resolve."
```

---

## 22. FEATURE BACKLOG PROMPTS

Each prompt below describes a complete, shippable feature. Implement them in order.

### F-01: Inline Checkpoint System

```
Prompt: "Before every agent run that will write files, automatically
create a git commit with message 'zoc: checkpoint before run <run_id>'.
Show a 'Restore checkpoint' button in the run trace card that calls
git_checkout on the checkpoint commit after user confirmation."
```

### F-02: Multi-File Diff Preview

```
Prompt: "When the agent completes its APPLYING phase, before committing
changes to disk, show a multi-file diff preview modal. The modal lists
all files the agent wants to modify with their diffs side by side.
The user can accept all, reject all, or accept individual files.
Only accepted files are written; rejected files are omitted from the run."
```

### F-03: Context Mention Picker

```
Prompt: "When the user types '@' in the Composer, open a floating dropdown
that searches the workspace file tree in real-time. Selecting a file inserts
'@filename' token into the message. The gateway must expand @ tokens into
the file's content (or a snippet if large) before sending to the LLM."
```

### F-04: Slash Commands

```
Prompt: "When the user types '/' in the Composer, show a command palette:
  /explain   → Ask mode, 'Explain how [selected code] works'
  /test      → Agent mode, 'Write tests for [current file]'
  /fix       → Agent mode, 'Fix all lint errors in [current file]'
  /document  → Agent mode, 'Add JSDoc/docstrings to [current file]'
  /refactor  → Agent mode, 'Refactor [selected code] for readability'
Selecting a command pre-fills the Composer with the correct mode and prompt."
```

### F-05: Live Token Budget Meter

```
Prompt: "Add a token budget meter to the AgentPanel header, visible only
during an active run. It shows a thin progress bar below the header
(color transitions from green → amber → red as usage increases).
Hover shows: 'X / Y tokens used · N iterations · N recoveries'.
When budget is 80% consumed, emit a toast notification."
```

### F-06: Autonomous Test Runner

```
Prompt: "After the agent writes code, automatically detect the project's
test command (look for 'test' script in package.json, Makefile, or
pyproject.toml). Run it in a PTY session, capture the output, and inject
the result into the next LLM call if any tests fail. Display a test
results mini-panel in the run trace with pass/fail counts."
```

### F-07: Model Benchmark Panel

```
Prompt: "Add a benchmark feature to the model picker.
When the user clicks 'Benchmark', run a fixed set of 5 prompts against
the active local model, measure time-to-first-token, tokens/second,
and response quality (scored by a self-evaluation prompt).
Show results in a chart. Store benchmark history per model in
~/.zoc-studio/benchmarks.json."
```

### F-08: Workspace Indexer Progress

```
Prompt: "The RAG indexer can take time on large codebases. Show a progress
indicator in the status bar: 'Indexing workspace... N/M files'.
The indexer must emit progress events on a websocket at
/v1/workspace/index-progress. On completion, show a toast
'Workspace indexed — N files, M tokens'."
```

### F-09: Agent Persona / Instruction Files

```
Prompt: "Support a .zoc/instructions.md file in the workspace root.
If present, the gateway prepends its contents to the system prompt for
every run in that workspace. This lets users customize agent behavior
per project (e.g. 'always use tabs, never use semicolons, follow SOLID').
Show an 'Edit instructions' link in the agent panel header."
```

### F-10: Session Export

```
Prompt: "Add an 'Export session' option to the agent panel kebab menu.
It exports the full session as a Markdown file with:
- Task description
- All agent messages and tool calls (formatted as code blocks)
- Files changed (with unified diffs)
- Total tokens used and duration
Save to the workspace root as 'zoc-session-<date>.md'."
```

---

## QUICK REFERENCE

| What you want to do | File to edit | Prompt keyword |
|---|---|---|
| Add a new FSM state | services/gateway/fsm.py | "FSM transition" |
| Add a new agent tool | services/gateway/toolsets.py | "new tool" |
| Add a new Tauri IPC command | apps/desktop/src/lib.rs | "tauri::command" |
| Add a new frontend feature | apps/frontend/src/features/ | "new feature panel" |
| Add a new SSE event type | services/gateway/events.py | "EventType" |
| Change the system prompt | services/gateway/prompts.py | "system prompt" |
| Add a new model provider | services/gateway/model_runtime.py | "provider config" |
| Change design tokens | apps/frontend/src/styles/globals.css | "zoc-*" |
| Add a new UI component | apps/frontend/src/components/ui/ | "shadcn" |
| Add a Rust test | apps/desktop/src/\*.rs | "#[cfg(test)]" |
| Add a Python property test | services/gateway/tests/ | "hypothesis @given" |

---

*Generated for Zoc Studio — local-first AI coding agent desktop app.*
*Stack: Tauri v2 · React 18 · FastAPI · llama.cpp · Monaco · xterm.js*
