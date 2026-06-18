# Monorepo Architecture Map

Snapshot date: 2026-06-16

This document maps the current Zoc AI / zoc-studio monorepo so future agents
can understand the structure before changing code. It is based on the current
filesystem, root manifests, package manifests, and source folder layout.

## At A Glance

Zoc AI is a local-first agentic coding desktop application.

Main runtime layers:

1. Tauri desktop shell in Rust.
2. React/Vite frontend in TypeScript.
3. FastAPI agent sidecar in Python.
4. Rust hotpath helper crate for PTY, file watching, search, patching, and
   indexing.
5. Shared schema package where Python/Pydantic models generate TypeScript
   types.

Approximate file counts from this snapshot:

- 501 repo files visible to `rg --files` after excluding heavy build folders
  such as `node_modules`, `target`, `dist`, `build`, and `*.tsbuildinfo`.
- 187 frontend source files under `apps/frontend/src`.
- 106 Python agent source/test files under `services/agent/src` and
  `services/agent/tests`, excluding `__pycache__`.
- 19 Rust source files under `apps/desktop/src` and `crates/hotpath/src`.
- 8 shared schema files under `packages/shared-types`, excluding generated
  caches and install folders.

## A-Z Full File And Folder Map

This map lists the full current project source tree in alphabetical order. It
intentionally excludes dependency/cache/build noise such as `.git`, `.venv`,
`node_modules`, `target`, `dist`, `build`, `__pycache__`, `.pytest_cache`,
`.mypy_cache`, `.ruff_cache`, `testsprite_tests/tmp`, and `*.tsbuildinfo`.

```text
Archivezip/
- .agents/
  - agent_assets_metadata.toml
- .claude/
  - settings.local.json
- .codex/
- .editorconfig
- .gitignore
- .inv.txt
- .kiro/
  - settings/
    - mcp.json
  - specs/
    - studio-ui-redesign/
      - .config.kiro
      - AGENT_REDESIGN_PLAN.md
      - design.md
      - requirements.md
      - tasks.md
- .kombai/
  - canvas/
    - 1.html
    - 2.html
    - 3.html
    - zoc-studio-redesign.canvas
- .pre-commit-config.yaml
- .prettierignore
- .prettierrc.json
- .replit
- .sum.txt
- .tsc.txt
- .vscode/
  - settings.json
- .vt.txt
- CHANGELOG.md
- Cargo.lock
- Cargo.toml
- MONOREPO_ARCHITECTURE.md
- Makefile
- README.md
- REPLIT_AGENT_WORKFLOW_IMPLEMENTATION.md
- VERSION
- agent.me
- apps/
  - desktop/
    - .gitignore
    - Cargo.toml
    - README.md
    - binaries/
      - zoc-studio-agent-x86_64-unknown-linux-gnu
      - zoc-studio-hotpath-x86_64-unknown-linux-gnu
    - build.rs
    - capabilities/
      - default.json
    - gen/
      - schemas/
        - acl-manifests.json
        - capabilities.json
        - desktop-schema.json
        - linux-schema.json
    - icons/
      - 128x128.png
      - 128x128@2x.png
      - 32x32.png
      - 64x64.png
      - Square107x107Logo.png
      - Square142x142Logo.png
      - Square150x150Logo.png
      - Square284x284Logo.png
      - Square30x30Logo.png
      - Square310x310Logo.png
      - Square44x44Logo.png
      - Square71x71Logo.png
      - Square89x89Logo.png
      - StoreLogo.png
      - android/
        - mipmap-anydpi-v26/
          - ic_launcher.xml
        - mipmap-hdpi/
          - ic_launcher.png
          - ic_launcher_foreground.png
          - ic_launcher_round.png
        - mipmap-mdpi/
          - ic_launcher.png
          - ic_launcher_foreground.png
          - ic_launcher_round.png
        - mipmap-xhdpi/
          - ic_launcher.png
          - ic_launcher_foreground.png
          - ic_launcher_round.png
        - mipmap-xxhdpi/
          - ic_launcher.png
          - ic_launcher_foreground.png
          - ic_launcher_round.png
        - mipmap-xxxhdpi/
          - ic_launcher.png
          - ic_launcher_foreground.png
          - ic_launcher_round.png
        - values/
          - ic_launcher_background.xml
      - icon.icns
      - icon.ico
      - icon.png
      - ios/
        - AppIcon-20x20@1x.png
        - AppIcon-20x20@2x-1.png
        - AppIcon-20x20@2x.png
        - AppIcon-20x20@3x.png
        - AppIcon-29x29@1x.png
        - AppIcon-29x29@2x-1.png
        - AppIcon-29x29@2x.png
        - AppIcon-29x29@3x.png
        - AppIcon-40x40@1x.png
        - AppIcon-40x40@2x-1.png
        - AppIcon-40x40@2x.png
        - AppIcon-40x40@3x.png
        - AppIcon-512@2x.png
        - AppIcon-60x60@2x.png
        - AppIcon-60x60@3x.png
        - AppIcon-76x76@1x.png
        - AppIcon-76x76@2x.png
        - AppIcon-83.5x83.5@2x.png
    - package.json
    - src/
      - checks.rs
      - fs_commands.rs
      - git.rs
      - lib.rs
      - llama_server.rs
      - main.rs
      - patch.rs
      - search_commands.rs
      - secrets.rs
      - sidecar.rs
      - workspace.rs
    - tauri.conf.json
  - frontend/
    - .eslintrc.cjs
    - .ladle/
      - components.tsx
      - config.mjs
    - components.json
    - eslint.config.js
    - index.html
    - package.json
    - postcss.config.js
    - src/
      - App.tsx
      - __tests__/
        - agent-client.test.ts
        - agent-panel-tools.test.tsx
        - arbitraries.ts
        - command-palette.test.tsx
        - diff-utils.test.ts
        - memory-indicator.test.tsx
        - monaco-view.test.tsx
        - onboarding.test.tsx
        - outline-panel.test.tsx
        - permissions.test.tsx
        - problems-panel.test.tsx
        - search-panel.test.tsx
        - search-text.test.tsx
        - setup.ts
        - showcase.test.tsx
        - source-control.test.tsx
        - sse.test.ts
        - status-bar.test.tsx
        - store.test.ts
        - timeline-panel.test.tsx
      - components/
        - layout/
          - ActivityBar.tsx
          - BottomDock.tsx
          - Shell.tsx
          - SidePanel.tsx
          - StatusBar.tsx
          - TopBar.tsx
        - ui/
          - badge.tsx
          - button.stories.tsx
          - button.tsx
          - card.tsx
          - checkbox.tsx
          - collapsible.tsx
          - command.tsx
          - dialog.tsx
          - dropdown-menu.tsx
          - input.tsx
          - kbd.tsx
          - label.tsx
          - popover.tsx
          - scroll-area.tsx
          - select.tsx
          - separator.tsx
          - sheet.tsx
          - switch.tsx
          - tabs.tsx
          - textarea.tsx
          - toast.tsx
          - tooltip.tsx
      - features/
        - agent/
          - AgentMenu.tsx
          - AgentPanel.tsx
          - AgentTimeline.tsx
          - AttachmentChips.tsx
          - CheckpointsPanel.tsx
          - Composer.tsx
          - ContextBar.tsx
          - ContextLimitDialog.tsx
          - DiffCard.tsx
          - EmptyState.tsx
          - MemoryIndicator.tsx
          - MentionAutocomplete.tsx
          - MessageItem.tsx
          - MessageQueue.tsx
          - ModelPicker.tsx
          - RulesDialog.tsx
          - SlashAutocomplete.tsx
          - ToolCallCard.tsx
          - agent.stories.tsx
          - marketing.stories.tsx
        - debug/
          - RunDebugPanel.tsx
        - diff/
          - DiffReviewView.tsx
        - editor/
          - Breadcrumbs.tsx
          - EditorArea.tsx
          - EditorTabs.tsx
          - InlineDiffView.tsx
          - InlineEditPrompt.tsx
          - MonacoView.tsx
        - files/
          - FileTree.tsx
        - indexer/
          - IndexerPanel.tsx
        - onboarding/
          - OnboardingWizard.tsx
        - outline/
          - OutlinePanel.tsx
        - palette/
          - CommandPalette.tsx
        - problems/
          - LogsPanel.tsx
          - OutputPanel.tsx
          - ProblemsPanel.tsx
        - scm/
          - SourceControlPanel.tsx
        - search/
          - SearchPanel.tsx
        - sessions/
          - SessionsPanel.tsx
          - SessionsView.tsx
        - settings/
          - SettingsView.tsx
          - sections/
            - Appearance.tsx
            - Extensions.tsx
            - General.tsx
            - Indexer.tsx
            - Keybindings.tsx
            - Mcp.tsx
            - Models.tsx
            - Permissions.tsx
            - Profiles.tsx
            - Providers.tsx
            - Trust.tsx
        - showcase/
          - ShowcaseView.tsx
        - tasks/
          - TasksPanel.tsx
        - terminal/
          - TerminalPane.tsx
        - timeline/
          - TimelinePanel.tsx
      - lib/
        - __tests__/
          - commands.test.ts
          - composer-validate.prop.test.ts
          - context-mentions.prop.test.ts
          - context-usage.prop.test.ts
          - diff-utils.prop.test.ts
          - editor-actions.test.ts
          - event-ingest.prop.test.ts
          - format-elapsed.prop.test.ts
          - inline-edit.prop.test.ts
          - keybinding-overrides.test.ts
          - launch-configs.test.ts
          - layout.prop.test.ts
          - mcp-config.test.ts
          - outline.test.ts
          - paths.test.ts
          - permissions-engine.test.ts
          - plan-progress.prop.test.ts
          - plugin-manifest.test.ts
          - plugins.test.ts
          - problem-matchers.test.ts
          - profiles.test.ts
          - providers.test.ts
          - recents.test.ts
          - reconnect.prop.test.ts
          - reduced-motion.prop.test.ts
          - rules-sources.test.ts
          - run-machine.prop.test.ts
          - secure-store.test.ts
          - session-query.prop.test.ts
          - settings.test.ts
          - status-bar.test.ts
          - tasks.test.ts
          - timeline.test.ts
          - trust.test.ts
        - agent-client.ts
        - commands.ts
        - composer-validate.ts
        - constants.ts
        - context-mentions.ts
        - context-tracker.ts
        - context-usage.ts
        - diff-utils.ts
        - editor-actions.ts
        - event-ingest.ts
        - format-elapsed.ts
        - inline-edit.ts
        - key-bindings.ts
        - keybinding-overrides.ts
        - launch-configs.ts
        - layout.ts
        - local-models.ts
        - mcp-config.ts
        - mock-data.ts
        - outline.ts
        - paths.ts
        - permissions-engine.ts
        - plan-progress.ts
        - plugin-manifest.ts
        - plugins.ts
        - problem-matchers.ts
        - profiles.ts
        - providers.ts
        - recents.ts
        - reconnect.ts
        - reduced-motion.ts
        - rules-sources.ts
        - run-machine.ts
        - secure-store.ts
        - session-query.ts
        - settings.ts
        - slash-commands.ts
        - sse.ts
        - status-bar.ts
        - store.ts
        - tasks.ts
        - tauri-bridge.ts
        - telemetry.ts
        - terminal-manager.ts
        - timeline.ts
        - trust.ts
        - use-viewport.ts
        - utils.ts
      - main.tsx
      - styles/
        - globals.css
      - types.ts
    - tailwind.config.ts
    - tsconfig.json
    - tsconfig.node.json
    - vite.config.ts
    - vitest.config.ts
- attached_assets/
  - Screenshot_20260529_103608_1780032376646.png
  - Screenshot_20260529_103759_1780032386029.png
  - Screenshot_20260529_103837_1780032386029.png
  - generated_images/
    - zoc_studio_icon_source.png
  - screenshots/
    - lmstudio_ai.png
- crates/
  - hotpath/
    - Cargo.toml
    - README.md
    - src/
      - bin/
        - cli.rs
      - chunker.rs
      - fs_watch.rs
      - indexer.rs
      - lib.rs
      - patch.rs
      - pty.rs
      - search.rs
- develop.md
- doc/
  - 5years.me
  - 5ypro.me
  - 6plans.me
  - 6pro.me
  - dev/
    - README.md
    - agent-collapse-plan.md
    - agent-expansion.md
    - agent-run-flow.md
    - ask-mode.md
    - build-and-packaging.md
    - checkpoints.md
    - command-system.md
    - context-mentions.md
    - dead-code-cleanup.md
    - diagnostics.md
    - editor-save-and-secrets.md
    - editor-workbench.md
    - extensions.md
    - file-operations.md
    - frontend-agent-panel.md
    - inline-edit.md
    - project-rules.md
    - rebrand-status.md
    - run-and-debug.md
    - search-and-replace.md
    - security.md
    - settings-and-keybindings.md
    - source-control.md
    - status-bar.md
    - tasks.md
    - terminal.md
    - testing.md
    - trust-and-permissions.md
  - project.me
- package.json
- packages/
  - shared-types/
    - README.md
    - python/
      - pyproject.toml
      - shared_schema/
        - __init__.py
        - models.py
    - scripts/
      - generate_ts.py
    - typescript/
      - package.json
      - src/
        - index.ts
      - tsconfig.json
- pnpm-lock.yaml
- pnpm-workspace.yaml
- pyproject.toml
- python/
  - zoc_studio_neural/
  - tests/
- replit.nix
- scripts/
  - bundle_sidecar.py
  - make_zip.sh
  - post-merge.sh
  - prepare_tauri_build.sh
  - release.sh
  - scan_secrets.py
  - stage_dev_binaries.py
  - stamp_version.py
  - verify_zip.py
- services/
  - agent/
    - README.md
    - pyproject.toml
    - src/
      - zoc_studio_agent/
        - __init__.py
        - agent/
          - __init__.py
          - checkpoints.py
          - context_search.py
          - memory.py
          - orchestrator.py
          - planner.py
          - project_rules.py
          - recall.py
          - summariser.py
          - validation.py
          - workspace_diff.py
          - zoc_run.py
        - app.py
        - approvals.py
        - commands/
          - __init__.py
          - recipes.py
          - registry.py
        - config.py
        - deps.py
        - events/
          - __init__.py
          - bus.py
        - hotpath.py
        - indexer/
          - __init__.py
          - embeddings.py
          - service.py
          - store.py
        - modes/
          - __init__.py
          - code_review.py
          - inline_edit.py
          - terminal.py
          - test_gen.py
        - permissions.py
        - persistence/
          - __init__.py
          - db.py
          - repository.py
        - providers/
          - __init__.py
          - anthropic.py
          - base.py
          - gemini.py
          - llamacpp.py
          - mock.py
          - openai.py
          - registry.py
        - reconcile.py
        - runs.py
        - scripts/
          - __init__.py
          - launch.py
        - state.py
        - tools/
          - __init__.py
          - ast.py
          - base.py
          - filesystem.py
          - index.py
          - registry.py
          - sandbox.py
          - search.py
          - shell.py
          - workspace.py
        - v1/
          - __init__.py
          - agent_run.py
          - commands.py
          - context.py
          - indexer.py
          - inline_edit.py
          - memory.py
          - messages.py
          - providers.py
          - review.py
          - router.py
          - rules.py
          - sessions.py
          - settings.py
          - terminal.py
          - tools.py
    - tests/
      - conftest.py
      - smoke/
        - __init__.py
        - conftest.py
        - test_local_llm_smoke.py
      - test_byo_provider.py
      - test_checkpoints.py
      - test_commands.py
      - test_context_search.py
      - test_fuzzy_patch.py
      - test_health.py
      - test_index_config_route.py
      - test_indexer.py
      - test_inline_edit.py
      - test_modes.py
      - test_orchestrator.py
      - test_orchestrator_approval.py
      - test_orchestrator_approval_recovery.py
      - test_permissions.py
      - test_persistence.py
      - test_persistence_resume.py
      - test_phase_e_coverage.py
      - test_project_rules.py
      - test_providers.py
      - test_run_registry.py
      - test_sandbox.py
      - test_settings_route.py
      - test_terminal_routes.py
      - test_tools.py
      - test_v1_routes.py
      - test_watcher_reconcile.py
      - test_zoc_run.py
- testsprite_tests/
  - TC001_Send_a_coding_prompt_and_receive_a_streamed_agent_response.py
  - TC001_Start_an_Ask_mode_conversation.py
  - TC001_gethealthendpointreturns200whenservicerunning.py
  - TC002_Choose_a_workspace_and_enter_the_main_shell.py
  - TC002_Send_a_prompt_and_see_the_assistant_respond.py
  - TC002_postv1sessionscreatesnewsession.py
  - TC003_Complete_first_time_workspace_setup.py
  - TC003_Save_Groq_provider_settings_and_discover_models.py
  - TC003_postv1sessionsessionidagentrunstartsagentrun.py
  - TC004_Create_a_new_chat_session.py
  - TC004_Stop_an_in_flight_assistant_run.py
  - TC004_getv1providersreturnsconfiguredproviders.py
  - TC005_Stop_an_in_flight_chat_run.py
  - TC005_Switch_to_another_chat_session.py
  - TC005_postv1providersdiscovermodelsreturnsmodelsforprovider.py
  - TC006_Open_settings_and_discover_Groq_models.py
  - TC006_See_streamed_assistant_progress_during_a_run.py
  - TC006_getv1commandsreturnsavailablecommands.py
  - TC007_Choose_a_Groq_model_in_the_agent_panel.py
  - TC007_Inspect_tool_activity_in_a_chat_run.py
  - TC007_postv1toolsessionidtoolnameinvokeinvokestool.py
  - TC008_Delete_a_chat_session.py
  - TC008_Inspect_tool_details_from_a_chat_run.py
  - TC008_getv1settingsreturnscurrentsettings.py
  - TC009_Rename_a_chat_session.py
  - TC009_Use_a_slash_command_in_chat.py
  - TC009_postv1terminalopensessionandreturnsid.py
  - TC010_Choose_a_local_llama.cpp_model_and_see_its_status.py
  - TC010_Use_the_integrated_terminal_to_run_a_command.py
  - TC011_Switch_to_Ask_mode_and_receive_a_direct_assistant_answer.py
  - TC011_Switch_to_a_different_model.py
  - TC012_Create_and_switch_between_sessions.py
  - TC012_View_the_current_session_after_provider_configuration_persists.py
  - TC013_Attach_context_before_sending_a_prompt.py
  - TC013_Stop_a_long_running_agent_response.py
  - TC014_Configure_a_local_llama.cpp_model_and_continue_chatting.py
  - TC014_Open_the_command_palette_and_run_a_command.py
  - TC015_Open_a_file_from_search_results.py
  - TC015_Reject_an_invalid_Groq_key_without_enabling_models.py
  - standard_prd.json
  - testsprite_backend_test_plan.json
  - testsprite_frontend_test_plan.json
- uv.lock
```

## Workspace Manifests

Root JavaScript workspace:

- `package.json`
  - Product name/version: `zoc-studio` `2.0.0`.
  - Main commands:
    - `pnpm dev`
    - `pnpm dev:frontend`
    - `pnpm dev:agent`
    - `pnpm build`
    - `pnpm check`
    - `pnpm schema:generate`
    - `pnpm release`
- `pnpm-workspace.yaml`
  - Includes:
    - `apps/*`
    - `packages/*/typescript`
    - `zoc-model`

Root Python workspace:

- `pyproject.toml`
  - Project: `zoc-studio-workspace`
  - Python: `>=3.11`
  - uv members:
    - `services/agent`
    - `packages/shared-types/python`
  - Ruff, mypy, pytest config live here.

Root Rust workspace:

- `Cargo.toml`
  - Members:
    - `apps/desktop`
    - `crates/hotpath`
  - Shared workspace package metadata and dependencies.

## Runtime Process Model

```text
User
  |
  v
Tauri window
  |
  | renders webview
  v
React frontend
  |
  | Tauri IPC for local shell capabilities
  | HTTP/SSE to loopback FastAPI agent
  v
FastAPI agent sidecar
  |
  | provider calls, tools, persistence, approvals, checkpoints
  | optional child process calls
  v
Rust hotpath CLI
  |
  | PTY, search, fs watch, patch, indexing helpers
  v
Workspace files
```

Important runtime rules:

- The agent sidecar must bind to loopback only.
- The desktop shell owns sidecar startup and discovers the sidecar port.
- Frontend talks to the agent through the local client in
  `apps/frontend/src/lib/agent-client.ts`.
- Pydantic shared schema is the source of truth for cross-language payloads.
- TypeScript shared types must be regenerated after changing Python schemas.

## Package Responsibility Map

### `apps/frontend`

Role:

- Main IDE user interface.
- React 18, Vite, TypeScript, Tailwind, Radix/shadcn-style UI, Zustand store.

Important files:

- `apps/frontend/src/App.tsx`
  - Bootstraps settings, plugins, sessions, Tauri workspace scope, model status,
    and renders `Shell`.
- `apps/frontend/src/components/layout/Shell.tsx`
  - Main IDE frame: top bar, activity bar, side panel, editor area, right agent
    panel, bottom dock, status bar, command palette, toast layer.
- `apps/frontend/src/lib/store.ts`
  - Central application state and many frontend workflows.
- `apps/frontend/src/lib/agent-client.ts`
  - HTTP/SSE client for FastAPI agent sidecar.
- `apps/frontend/src/main.tsx`
  - React entry point.

Feature folders:

- `features/agent`
  - Agent panel, composer, timeline, model picker, checkpoints, rules,
    attachments, slash and mention autocomplete.
- `features/editor`
  - Editor area, Monaco, tabs, breadcrumbs, inline edit, inline diff.
- `features/files`
  - Explorer/file tree.
- `features/search`
  - Search panel.
- `features/scm`
  - Source control panel.
- `features/terminal`
  - Terminal pane.
- `features/problems`
  - Problems, output, logs.
- `features/palette`
  - Command palette.
- `features/settings`
  - Settings view and sections.
- `features/sessions`
  - Session panels/views.
- `features/debug`
  - Run/debug panel.
- `features/tasks`
  - Task panel.
- `features/timeline`
  - Timeline panel.
- `features/indexer`
  - Indexer UI.
- `features/onboarding`
  - First-run onboarding wizard.
- `features/diff`
  - Diff review view.
- `features/showcase`
  - Showcase/demo UI.

Shared frontend folders:

- `components/layout`
  - IDE shell chrome.
- `components/ui`
  - Reusable UI primitives.
- `lib`
  - Store, clients, command registry, settings, paths, permissions, tasks,
    terminal manager, context logic, plugins, telemetry, tests.
- `styles`
  - Global styling.
- `src/__tests__` and `src/lib/__tests__`
  - Frontend tests.

### `apps/desktop`

Role:

- Tauri v2 desktop shell.
- Owns native window, capabilities, secrets, filesystem commands, sidecar
  startup, local llama server integration, patch/search IPC, and bundled
  binaries.

Important files:

- `apps/desktop/src/main.rs`
  - Desktop binary entry point.
- `apps/desktop/src/lib.rs`
  - Tauri app setup and command registration.
- `apps/desktop/src/sidecar.rs`
  - FastAPI sidecar launch and lifecycle.
- `apps/desktop/src/llama_server.rs`
  - Local llama server supervision/status.
- `apps/desktop/src/workspace.rs`
  - Workspace root and trust/scope behavior.
- `apps/desktop/src/fs_commands.rs`
  - Filesystem IPC commands.
- `apps/desktop/src/search_commands.rs`
  - Search IPC commands.
- `apps/desktop/src/git.rs`
  - Git-related desktop commands.
- `apps/desktop/src/patch.rs`
  - Patch/diff helpers.
- `apps/desktop/src/secrets.rs`
  - Secure credential storage.
- `apps/desktop/src/checks.rs`
  - Runtime checks/diagnostics.
- `apps/desktop/tauri.conf.json`
  - Tauri config, external binaries, bundle settings.
- `apps/desktop/capabilities/default.json`
  - Tauri capability permissions.
- `apps/desktop/binaries`
  - Bundled sidecar and hotpath binaries.
- `apps/desktop/icons`
  - Platform app icons.

### `services/agent`

Role:

- Python FastAPI sidecar.
- Owns agent orchestration, providers, tools, persistence, sessions, approvals,
  memory, indexing, checkpoints, rules, API routes, and streamed events.

Important package files:

- `services/agent/pyproject.toml`
  - Python package, dependencies, script entry point, test config.
- `services/agent/src/zoc_studio_agent/app.py`
  - FastAPI app factory, lifecycle repair, router registration.
- `services/agent/src/zoc_studio_agent/state.py`
  - App state construction.
- `services/agent/src/zoc_studio_agent/config.py`
  - Settings.
- `services/agent/src/zoc_studio_agent/deps.py`
  - FastAPI dependency helpers.
- `services/agent/src/zoc_studio_agent/scripts/launch.py`
  - Sidecar CLI entry point.

Main agent folders:

- `agent`
  - Orchestrator, planner, memory, summariser, recall, checkpoints,
    workspace diff, validation, project rules, context search, Zoc run model.
- `v1`
  - Versioned API routes:
    - agent run
    - commands
    - context
    - indexer
    - inline edit
    - memory
    - messages
    - providers
    - review
    - rules
    - sessions
    - settings
    - terminal
    - tools
- `tools`
  - Tool registry and tool implementations:
    - filesystem
    - shell
    - search
    - workspace
    - AST
    - index
    - sandbox
- `providers`
  - LLM providers:
    - OpenAI-compatible
    - Anthropic
    - Gemini
    - llama.cpp
    - mock
    - provider registry
- `commands`
  - Slash command registry and recipes.
- `events`
  - Event bus.
- `indexer`
  - Embeddings, index service, vector/store logic.
- `modes`
  - Code review, inline edit, terminal, test generation.
- `persistence`
  - Database and repository logic.

Agent tests:

- `services/agent/tests`
  - Route tests, orchestrator tests, provider tests, persistence tests, sandbox
    tests, approval tests, terminal tests, indexer tests, project rules tests,
    checkpoint tests, context search tests, inline edit tests, and smoke tests.

### `crates/hotpath`

Role:

- Rust helper library and CLI for operations that should be faster or more
  native than Python.

Important files:

- `crates/hotpath/src/lib.rs`
  - Library exports.
- `crates/hotpath/src/bin/cli.rs`
  - CLI entry point.
- `crates/hotpath/src/pty.rs`
  - Pseudo-terminal support.
- `crates/hotpath/src/fs_watch.rs`
  - File watcher.
- `crates/hotpath/src/search.rs`
  - Search helper.
- `crates/hotpath/src/indexer.rs`
  - Code indexing helper.
- `crates/hotpath/src/patch.rs`
  - Patch helper.
- `crates/hotpath/src/chunker.rs`
  - Chunking logic.

### `packages/shared-types`

Role:

- Cross-language API/event/schema contract.
- Python Pydantic models are the source of truth.
- TypeScript types are generated from Python models.

Important files:

- `packages/shared-types/python/shared_schema/models.py`
  - Source schema definitions.
- `packages/shared-types/python/shared_schema/__init__.py`
  - Python package exports.
- `packages/shared-types/typescript/src/index.ts`
  - Generated or maintained TypeScript types consumed by frontend.
- `packages/shared-types/scripts/generate_ts.py`
  - Schema generator.
- `packages/shared-types/README.md`
  - Shared schema notes.

Alignment rule:

- When changing shared API/event models, update Python first, run
  `pnpm schema:generate`, then update frontend/backend callers.

### `scripts`

Role:

- Release and build automation.

Important files:

- `scripts/stamp_version.py`
  - Stamps `VERSION` across manifests.
- `scripts/bundle_sidecar.py`
  - Bundles Python sidecar.
- `scripts/stage_dev_binaries.py`
  - Stages dev binaries.
- `scripts/prepare_tauri_build.sh`
  - Prepares frontend and bundled binaries before Tauri build.
- `scripts/release.sh`
  - Release pipeline.
- `scripts/make_zip.sh`
  - Creates release zip.
- `scripts/verify_zip.py`
  - Verifies zip contents.
- `scripts/scan_secrets.py`
  - Secret scan helper.
- `scripts/post-merge.sh`
  - Post-merge helper.

### `doc`

Role:

- Developer documentation and planning records.

Important areas:

- `doc/dev`
  - Focused feature docs for ask mode, agent flow, build/packaging, command
    system, context mentions, diagnostics, editor, file ops, frontend agent
    panel, inline edit, project rules, run/debug, search, security, settings,
    source control, status bar, tasks, terminal, testing, trust/permissions.
- `doc/*.me`
  - User/planning notes that appear to be active project planning artifacts.

### `testsprite_tests`

Role:

- Generated or recorded product/API test cases and reports.

Important files:

- `testsprite_tests/TC*.py`
  - Individual generated test cases.
- `testsprite_tests/testsprite_backend_test_plan.json`
  - Backend test plan.
- `testsprite_tests/testsprite_frontend_test_plan.json`
  - Frontend test plan.
- `testsprite_tests/tmp`
  - Temporary report/config/output files.

### `attached_assets`

Role:

- Images, screenshots, generated visual assets.

Important folders:

- `attached_assets/generated_images`
- `attached_assets/screenshots`

### Agent And IDE Metadata

These folders support local planning/editor/agent workflows. They are not the
product runtime.

- `.agents`
- `.codex`
- `.claude`
- `.kiro`
- `.kombai`
- `.vscode`

## Current Non-Source Or Generated Areas

These folders/files should not be treated as primary source unless explicitly
needed:

- `.venv`
- `.mypy_cache`
- `.pytest_cache`
- `.ruff_cache`
- `python/.pytest_cache`
- `__pycache__` folders
- `apps/frontend/dist`
- `apps/frontend/tsconfig.tsbuildinfo`
- `packages/shared-types/typescript/node_modules`
- `packages/shared-types/typescript/tsconfig.tsbuildinfo`
- `services/agent/**/__pycache__`
- `testsprite_tests/tmp`
- `apps/desktop/binaries` unless working on bundle/runtime packaging

The `python/` directory currently appears to contain cache/test leftovers rather
than active source files. Review before using it as a product package.

## Source Dependency Direction

Preferred dependency flow:

```text
packages/shared-types/python
  -> packages/shared-types/typescript
  -> apps/frontend

services/agent
  -> packages/shared-types/python
  -> providers/tools/persistence/events

apps/frontend
  -> packages/shared-types/typescript
  -> services/agent through HTTP/SSE client
  -> apps/desktop through Tauri IPC bridge

apps/desktop
  -> crates/hotpath
  -> bundled services/agent sidecar binary

crates/hotpath
  -> standalone Rust helper library/CLI
```

Avoid reverse dependencies:

- Shared types must not import frontend or agent runtime code.
- Hotpath must not depend on frontend.
- Frontend must not directly know Python internals beyond API/schema contracts.
- Agent should not depend on frontend implementation details.
- Desktop shell should expose narrow IPC commands, not frontend-specific state.

## Main Development Flows

Frontend-only flow:

```text
apps/frontend/src/App.tsx
  -> components/layout/Shell.tsx
  -> feature panels
  -> lib/store.ts
  -> lib/agent-client.ts or lib/tauri-bridge.ts
```

Agent request flow:

```text
Composer or command
  -> apps/frontend/src/lib/store.ts
  -> apps/frontend/src/lib/agent-client.ts
  -> services/agent/src/zoc_studio_agent/v1/*
  -> services/agent/src/zoc_studio_agent/agent/orchestrator.py
  -> tools/providers/persistence/events
  -> streamed events back to AgentTimeline and store
```

Desktop command flow:

```text
Frontend Tauri bridge
  -> apps/desktop/src/lib.rs command registration
  -> apps/desktop/src/* command module
  -> workspace/filesystem/git/search/secret/sidecar behavior
```

Release flow:

```text
VERSION
  -> scripts/stamp_version.py
  -> frontend build
  -> hotpath release build
  -> sidecar bundle
  -> Tauri build
  -> dist/installers
  -> scripts/verify_zip.py
```

## Testing Map

Frontend:

- `apps/frontend/src/__tests__`
- `apps/frontend/src/lib/__tests__`
- Command:
  - `pnpm --filter @zoc-studio/frontend test`
  - `pnpm --filter @zoc-studio/frontend typecheck`
  - `pnpm --filter @zoc-studio/frontend lint`

Python agent:

- `services/agent/tests`
- Command:
  - `pytest services/agent/tests`
  - or package-local pytest through the uv workspace.

Rust:

- `apps/desktop`
- `crates/hotpath`
- Command:
  - `cargo check --workspace`
  - `cargo test --workspace`

Whole repo:

- `make check`
- `pnpm check`

## Alignment Rules For Future Agents

Before implementing:

1. Read this file.
2. Read `README.md`.
3. Read `develop.md` if the task is roadmap/development related.
4. Identify which layer owns the change:
   - frontend UI/state
   - desktop/Tauri IPC
   - Python sidecar/API/agent
   - Rust hotpath
   - shared schema
   - scripts/release
5. Change the smallest correct owner first.

When adding frontend behavior:

- Put reusable state or business logic in `apps/frontend/src/lib`.
- Put visible feature UI in `apps/frontend/src/features/<feature>`.
- Put shell/chrome layout changes in `apps/frontend/src/components/layout`.
- Use shared types from `@zoc-studio/shared-types` for API/event contracts.
- Add tests under `src/__tests__` or `src/lib/__tests__`.

When adding backend behavior:

- Put API route changes under `services/agent/src/zoc_studio_agent/v1`.
- Put orchestration logic under `agent`.
- Put model/provider integration under `providers`.
- Put filesystem/shell/search capabilities under `tools`.
- Put persistence changes under `persistence`.
- Add tests under `services/agent/tests`.

When changing shared contracts:

- Edit `packages/shared-types/python/shared_schema/models.py`.
- Regenerate TypeScript with `pnpm schema:generate`.
- Update consumers in `apps/frontend` and `services/agent`.
- Add schema drift tests or update existing test expectations.

When changing desktop/native behavior:

- Add or update Tauri commands in `apps/desktop/src`.
- Keep capabilities in `apps/desktop/capabilities/default.json` aligned.
- Use `crates/hotpath` for fast reusable local operations.
- Do not expose broad filesystem or shell access without trust/permission flow.

When changing release/build behavior:

- Update scripts in `scripts`.
- Update `README.md` if user-facing build commands change.
- Keep `VERSION`, package manifests, Python manifests, and Cargo manifests
  consistent through `scripts/stamp_version.py`.

## Architecture Health Notes

Strong boundaries already present:

- Clear apps/services/crates/packages separation.
- Tauri shell owns native desktop runtime.
- FastAPI sidecar owns agent intelligence and APIs.
- Shared schema package exists for cross-language contract stability.
- Rust hotpath crate isolates performance-sensitive local operations.
- Developer docs already exist under `doc/dev`.

Areas to keep aligned:

- Remove or ignore generated caches before architecture audits.
- Keep `develop.md`, `doc/dev`, and source behavior synchronized.
- Avoid duplicating source of truth between frontend mock data and backend APIs.
- Keep Ask/Agent/Plan/Debug behavior separate across backend config, event
  stream, frontend store, and timeline rendering.
- Keep generated TestSprite artifacts separate from curated tests.
- Review `python/` for cleanup because it currently appears cache-only.
