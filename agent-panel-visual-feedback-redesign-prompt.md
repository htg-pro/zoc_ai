# Development Prompt: Redesign Agent Panel Output Flow (Claude Code / Codex CLI Style)

## Context for the engineer/agent receiving this prompt

The current `AgentPanel.tsx` + `rows.tsx` implementation streams a raw, unfiltered
**"Thinking Process"** block (numbered chain-of-thought text) before every reply,
in both Ask mode and Agent mode. This is not how production coding-agent UIs work.
Real tools like Claude Code and Codex CLI never dump raw reasoning text as the
primary UI — they render a **structured, collapsible, step-by-step activity feed**
where reasoning is a minor, optional, collapsed element and the *actions* (file
reads, diffs, commands, results) are the headline content.

Your task: rebuild the run-output rendering layer so the panel produces the same
"live build feed" feel as Claude Code, not a chatbot dumping its internal monologue.

---

## 1. Problem Statement

Current behavior (confirmed from screenshots):
- Every single response — even "hi" — opens with a multi-paragraph "Thinking
  Process:" block rendered as plain assistant text, not as a distinct UI row.
- There is no visual distinction between *reasoning*, *the actual answer*, *tool
  calls*, *file edits*, or *command execution*.
- In Agent mode, the model asks clarifying questions back-and-forth with no
  visible plan, no step list, and no sense of "what is it doing right now."
- Nothing resembles `rows.tsx`'s own documented 8-type Event Contract
  (`intent`, `thinking`, `read-files`, `edit-file`, `command`, `summary`,
  `approval`, `done`) — it's all collapsing into a single wall of markdown text.

Goal: make the **Event Contract the literal source of truth for rendering**, so
the UI looks like a build log / agent trace, not a chat transcript.

---

## 2. Target UX Reference Behavior

Model the interaction on Claude Code / Codex CLI conventions:

1. **Reasoning is collapsed by default.** A single line like
   `▸ Thinking (4s)` that expands on click. Never auto-expanded, never the
   dominant visual element. Style it dimmed/secondary (muted gray, smaller
   font) vs. the primary response text.
2. **Every tool action gets its own compact row**, not prose:
   - `Read  src/App.tsx (1–24)`
   - `Edit  src/components/layout/Shell.tsx  +12 −3`
   - `Run   npm run build` with live streaming stdout in a monospace block
     and a final ✓/✗ exit-code badge.
3. **Status is always visible at the row and run level**: pending (spinner) →
   running (animated) → done (✓) / failed (✗). No row should sit in an
   ambiguous "is this still happening?" state.
4. **Diffs render as diffs**, not as text describing the diff. Use a two-column
   or inline +/− colored diff view per `edit-file` event, collapsible per file,
   with a top-level summary ("3 files changed, +42 −11").
5. **Commands stream output live**, line by line, in a terminal-styled block,
   capped height with scroll, auto-expand while running, auto-collapse (to
   last N lines + exit code) once finished.
6. **Approvals are inline gates**, not chat text. An `approval` row blocks
   forward progress visually (e.g., dimmed/disabled subsequent rows) until
   Approve/Reject is clicked.
7. **The final assistant message is short and conversational** — a `summary`
   row in plain language — *after* the structured trace, the way Claude Code
   prints a short wrap-up after the tool trace, not a 600-word "Final Output
   Generation" essay.
8. **Ask mode** (read-only) should look materially different from **Agent
   mode**: no edit/command/approval rows ever appear in Ask mode; it's just
   `thinking` (collapsed) → streamed answer text. Agent mode shows the full
   FSM trace.

---

## 2.5 Reference Mockup — Exact Target Spec

A reference mockup ("Add a dark mode toggle to the settings page") defines the
literal pixel/behavior target. Build to this spec exactly — it is the
canonical answer to "what should this look like."

### A. Run header
- Header row: status dot (●, color-coded: orange = running, green = done, red
  = failed, gray = idle) + **"Agent run"** label + a small **checkpoint
  badge** (branch icon + "checkpoint set") whenever the FSM has snapshotted
  workspace state for rollback + right-aligned run status text ("Running…",
  "Done", "Failed").
- The whole run card has a **left accent bar** (colored vertical strip,
  matching the status dot color) running the full height of the card — this
  is the at-a-glance "is something happening" signal, distinct from any
  individual row's own status icon.

### B. TO-DO / Plan list (new, currently missing entirely)
- Immediately under the header: a **"TO-DO"** section showing the agent's own
  task breakdown for this run, e.g.:
  ```
  ✓ Find the theme provider        (done — checkmark, strikethrough text)
  ✓ Add toggle component           (done — checkmark, strikethrough text)
  ✓ Wire up theme context          (done — checkmark, strikethrough text)
  ◐ Update global styles           (in progress — spinner icon, normal text)
  ```
- Completed items: green checkmark + strikethrough, muted color.
- The active item: animated spinner/partial-circle icon, full-opacity text.
- Not-yet-started items (if planned upfront): plain circle outline, muted text.
- This list is generated at `PLAN_EDITS`/`ANALYZE` stage and updated live as
  each sub-task completes — it is the single most important addition vs. the
  current build, because it gives users a running answer to "what is the plan
  and how far through it are we" without reading any prose.

### C. Activity feed
- Section label **"ACTIVITY"** (small caps, muted) above the row list.
- Every row — `Read`, `Write`, command, everything — uses the **same layout**:
  small type-icon on the left, label/path text, right-aligned metadata
  (diff stats or status), and a **chevron `›` on the far right on every row
  without exception**, signaling it's expandable. Consistency here matters
  more than per-type customization.
- Diff stats format: `+42 -0` with **+N always green, -N always red**, even
  when one side is zero — don't hide the zero value.
- Command rows (`npm run typecheck`) use a `>_` prompt icon and resolve to a
  compact inline result (`✓ pass` / `✗ fail`), not an expanded terminal block
  by default — only expand the full stdout on click.

### D. Review changes gate (this supersedes the plain `ApprovalRow` concept)
- A distinct card/section titled **"Review changes"** (with a small
  branch/diff icon) appears once edits are staged, showing aggregate stats
  in the header: `4 files +86 -12`.
- **Each file in the list has its own checkbox** (checked by default) — this
  is per-file selective apply, not a single all-or-nothing approve. Users can
  uncheck individual files before applying.
- Below the file list, a compact **status-checks row**: `✓ typecheck  ✓ build
  ✓ tests` — three independent pass/fail badges run automatically before the
  apply gate is presented, so the user reviews already-validated changes, not
  raw unverified diffs.
- Two actions, right-aligned: **`Discard`** (secondary/outline button) and
  **`Apply changes (N)`** (primary/filled, accent color, where N = count of
  currently-checked files, updates live as checkboxes toggle).
- **Loading state**: on click, `Apply changes` becomes `Applying…` with a
  spinner replacing its icon, stays primary-colored but visually busy;
  `Discard` becomes disabled/grayed during this window. Don't let both
  buttons be clickable mid-apply.

### E. Final summary placement
- After the Review-changes card (not interleaved inside it, not before it),
  render the short natural-language `summary` as a **separate rounded bubble**
  below the card — e.g. *"Added a dark mode toggle to the settings page. It
  reads and writes the theme through ThemeProvider and persists the choice
  across reloads."* One to two sentences, factual, no headers, no bullet list.

### F. Color/iconography conventions to standardize
| Element | Color/Style |
|---|---|
| Running status dot / accent bar | Orange/amber |
| Done / pass | Green |
| Failed | Red |
| Added lines (`+N`) | Green |
| Removed lines (`-N`) | Red |
| Review-changes icon | Violet/purple (visually distinct from run-status orange) |
| Thinking row | Muted gray, smaller text, lowest visual priority |
| Primary action (`Apply changes`) | Filled accent (orange/amber) |
| Secondary action (`Discard`) | Outline/ghost |

---

## 3. Concrete Implementation Tasks

### 3.1 Backend (`emit_gate.py`, `run_pipeline.py`, `fsm.py`)
- [ ] Stop concatenating chain-of-thought into the same text stream as the
      final answer. Emit `thinking` as its own discrete SSE event(s), separate
      from `summary`/answer text events.
- [ ] Ensure every FSM stage transition (`INTAKE → ANALYZE → MAP_FILES →
      READ_FILES → PLAN_EDITS → APPLY_EDITS → RUN_CHECKS → SUMMARY → DONE`)
      emits a corresponding `intent`/`read-files`/`edit-file`/`command`/`done`
      event — do not let a stage run silently and only surface as prose later.
- [ ] For Ask mode, explicitly suppress emission of `edit-file`, `command`,
      and `approval` event types at the gate level (defense in depth, not just
      a frontend filter).
- [ ] Cap/trim `thinking` payloads server-side (e.g., last/most-relevant N
      tokens or a generated 1-line gist) so the frontend isn't forced to render
      arbitrarily long raw reasoning even when expanded.
- [ ] **New event type: `plan`.** At `ANALYZE`/`PLAN_EDITS`, emit a `plan`
      event containing an ordered task list (`id`, `label`, `status:
      pending|active|done`). Emit incremental `plan-update` patches (just the
      changed item's status) as each sub-task completes, rather than
      re-sending the whole list — this drives the TO-DO section in 2.5.B.
- [ ] **New event type: `review`.** At the end of `APPLY_EDITS`/before commit,
      emit a `review` event bundling all staged `edit-file` diffs + the
      results of any pre-apply checks (typecheck/build/tests run
      automatically, not user-triggered) so the frontend can render the
      Review-changes gate from 2.5.D in one shot, with per-file checkbox
      state defaulting to "included."
- [ ] `POST /v1/agent/decision` must accept a **per-file selection payload**
      (list of accepted file paths), not just a binary approve/reject — wire
      `APPLY_EDITS` to only commit the selected subset, and route any
      unselected files into a discarded/no-op state without failing the run.
- [ ] Emit a `checkpoint` flag (or reuse `intent`) whenever a workspace
      snapshot is taken, so the header badge in 2.5.A has something to bind to.

### 3.2 Frontend row renderers (`rows.tsx`)
- [ ] **New `PlanRow` (TO-DO list)**: renders the `plan` event as a checklist
      per 2.5.B — checkmark + strikethrough for `done`, spinner for `active`,
      outline circle for `pending`. Subscribes to `plan-update` patches and
      updates individual list items in place (no full re-render/flicker).
- [ ] `ThinkingRow`: collapsed `<details>`-style component, header = elapsed
      time + optional 1-line gist (e.g., "Reasoning about file scope · 3s"),
      body = raw text only on expand, monospace/secondary styling.
- [ ] `ReadFilesRow`: render as a file-chip list with path + line range, icon
      per file type, click-to-preview. Include the chevron-on-the-right
      affordance per 2.5.C even though there's nothing destructive to show —
      consistency of the row pattern matters more than this row "needing" it.
- [ ] `EditFileRow`: real diff renderer (reuse a diff lib, e.g.
      `react-diff-view` or `diff2html`), per-file collapse, +/− counts in the
      row header (always show both numbers, green/red, even if one is 0),
      syntax highlighting.
- [ ] `CommandRow`: terminal-style block, streaming via the same SSE channel
      (don't wait for command completion to render first output line),
      auto-scroll while running. Default collapsed state shows just a `>_`
      icon + command + compact `✓ pass`/`✗ fail` badge (2.5.C); only expand
      full stdout on click, not automatically on completion.
- [ ] **Replace `ApprovalRow` with `ReviewChangesRow`** rendering the new
      `review` event per 2.5.D: header with file-count + aggregate `+N -N`
      stats, per-file checkbox list (default checked), a compact status-checks
      row (typecheck/build/tests badges), and `Discard` / `Apply changes (N)`
      buttons where N tracks live checkbox state. On click, POST the selected
      file-path subset to `/v1/agent/decision`; show `Applying…` (spinner,
      `Discard` disabled) until the response resolves; on failure, restore
      both buttons and surface a retry affordance (carried over from the old
      `ApprovalRow` failure-handling requirement).
- [ ] `SummaryBlock`/`DoneRow`: render as a separate rounded bubble placed
      *after* the `ReviewChangesRow`, per 2.5.E — short (1–2 sentence),
      no headers/bullets. This is the *only* row allowed to look like a
      normal chat bubble. If the model produces a long "Final Output
      Generation" essay, truncate/restyle — that content belongs in
      `thinking`, not `summary`.
- [ ] Add a top-of-run **progress strip** showing the FSM stage sequence as a
      breadcrumb/stepper (●──●──○──○...) so users always know where the run is
      — complementary to, not a replacement for, the `PlanRow` TO-DO list
      (the stepper is FSM-stage-level, the TO-DO list is task-level).
- [ ] `AgentPanel` header: add the **checkpoint badge** (branch icon +
      "checkpoint set") and the colored **left accent bar** on the run card
      per 2.5.A, keyed off run status (orange running / green done / red
      failed / gray idle).

### 3.3 `RunRegion.tsx`
- [ ] Merge chat + telemetry feeds in render order, but apply distinct visual
      "lanes": telemetry rows compact/technical, chat messages wider/conversational.
- [ ] On reconnect via `/v1/agent/diary`, replay events into the same row
      renderers (no special-cased "history" rendering path) so live and
      replayed runs look identical.

### 3.4 Composer / Control Bar
- [ ] Surface autonomy level and current FSM stage in the control bar at all
      times during a run (not just a static "idle"/model name).
- [ ] Pause/Stop should freeze the progress stepper visually, not just halt
      silently.

---

## 4. Acceptance Criteria (what "done" looks like)

- Asking "hi" in Ask mode produces: a collapsed one-line thinking row (if any)
  + a short greeting. No multi-paragraph reasoning visible by default.
- Asking the Agent to inspect a folder produces: a stepper showing
  INTAKE→ANALYZE→MAP_FILES..., live `read-files` rows as it scans, and a short
  natural-language summary at the end — not a clarifying-question wall of text
  unless genuinely blocked on missing input.
- An edit task shows real diffs with +/− counts per file, an approval gate
  before write, and streaming command output for any post-edit checks
  (lint/build/test).
- A "dark mode toggle" style edit task reproduces the reference mockup
  exactly: a live TO-DO list ticking off sub-tasks, an Activity feed of
  Read/Write/command rows, a Review-changes gate with per-file checkboxes
  and an aggregate `+86 -12` stat, a `✓ typecheck ✓ build ✓ tests` status row,
  working `Discard`/`Apply changes (N)` buttons with an `Applying…` loading
  state, and a one-sentence summary bubble after the gate.
- Visually and behaviorally, a non-technical reviewer should be able to tell
  this apart from a "chatbot pretending to code" and recognize it as a build
  trace, comparable in spirit to Claude Code's terminal/IDE trace output.

---

## 5. Notes / Constraints

- The Event Contract grows from 8 to **10 types**: the original 8 plus
  `plan` (+ `plan-update` patches) and `review` (replacing `approval`'s role
  for edit-heavy runs — keep `approval` only if some non-file-edit decision
  point still needs a plain yes/no gate). This is a deliberate, scoped
  extension to support 2.5.B and 2.5.D — don't expand further without a
  matching mockup requirement.
- Keep `EmitGate` schema validation as the single enforcement point for
  Ask-vs-Agent event filtering; don't duplicate that logic ad hoc in the
  frontend only.
- Local SLM output (e.g., a small Gemma model) is naturally verbose/raw in its
  reasoning — assume the model will keep emitting long "Thinking Process"
  text, and design the `thinking` row to absorb that gracefully (truncate,
  collapse, gist) rather than expecting the model to change its own output
  style.
