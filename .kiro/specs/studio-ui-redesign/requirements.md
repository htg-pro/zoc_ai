# Requirements Document

## Introduction

This feature redesigns the Zoc AI frontend (`apps/frontend`, a React + Vite + TypeScript + Tailwind + shadcn/ui app) to implement the three Kombai design canvases, and hardens the agent workflow that those canvases depict.

The three canvases describe a single cohesive product across three primary states:

- **Canvas 1 — Sessions view**: title bar, activity bar, sessions sidebar (Pinned / Today / Yesterday / Earlier groups), and a sessions dashboard (stat cards, filter tabs, search, sort, session cards with Resume / pin / delete actions).
- **Canvas 2 — Agent-editing workspace**: title bar with a "Running…" indicator, activity bar, file explorer with an "Agent is editing" badge, editor tabs, a code editor with highlighted "Agent editing" lines and a blinking caret, a terminal/problems dock with an agent-control toggle, and the right-hand Agent panel showing in-progress tasks, a progress bar, a run timeline/plan with checkmarks and spinners, autonomy level, model badge, and pause/stop controls.
- **Canvas 3 — Diff-review workspace**: explorer with change badges (A/M) and a "Review Pending" summary, a side-by-side diff editor, a "Reviewing changes 2 of 6" toolbar with previous/next/undo-file/apply-file controls, and the terminal/problems dock.

The work has four pillars: (1) implement the visual design with high fidelity; (2) deliver a polished agent chat/panel experience with accurate real-time states; (3) implement the motion/animation system while respecting reduced-motion preferences; and (4) find and fix correctness bugs in the agent run workflow (run lifecycle, streaming, plan/task progress, diff review, checkpoints).

This document defines **what** the redesigned application must do. Implementation choices (specific component decomposition, CSS approach) are deferred to design.

## Glossary

- **Studio_UI**: The Zoc AI frontend application rendered in `apps/frontend`.
- **Title_Bar**: The top chrome row containing window controls, branding, workspace path, git branch, the command palette entry, panel toggles, and the Run/Running control.
- **Activity_Bar**: The vertical icon rail on the far left (Explorer, Search, Indexer, Sessions, Tasks, Appearance, Settings).
- **Sessions_Sidebar**: The left panel listing conversation sessions grouped by recency (Pinned, Today, Yesterday, Earlier this week).
- **Sessions_Dashboard**: The main-area view showing session statistics, filters, search, sort, and session cards.
- **Session_Card**: A row in the Sessions_Dashboard representing one session, with status, model metadata, and Resume / pin / delete actions.
- **File_Explorer**: The left panel in the workspace views showing the workspace file tree with VCS/agent-edit status badges.
- **Editor_View**: The central code-editing surface with editor tabs and a syntax-highlighted code area.
- **Diff_View**: The central side-by-side change-review surface with added (`+`) and removed (`−`) lines.
- **Review_Toolbar**: The toolbar above the Diff_View showing "Reviewing changes N of M", per-file change counts, and previous/next/open/undo/apply controls.
- **Bottom_Dock**: The lower panel containing Terminal, Problems, and Logs tabs plus the agent-control toggle.
- **Agent_Panel**: The right-hand panel that is the primary agent chat and run-status surface, including header, run controls, run timeline, context bar, and message composer.
- **Agent_Composer**: The message input area at the bottom of the Agent_Panel, including attachments, Plan/Build mode toggle, autonomy selector, and send control.
- **Run**: A single agent execution triggered by a user message or command, identified by a run id, progressing through a lifecycle of states.
- **Run_Lifecycle**: The set of Run states: `idle`, `running`, `paused`, `stopped`, `completed`, and `error`.
- **Run_Timeline**: The ordered list of plan steps and tool actions shown in the Agent_Panel during a Run, with per-step status indicators.
- **Plan**: The agent's ordered list of steps for a Run, each step having a status (`done`, `in_progress`, `queued`).
- **Checkpoint**: A restorable snapshot of workspace state created during a Run, which the user can roll back to.
- **Agent_Event**: A typed event received over the Server-Sent-Events (SSE) stream describing Run progress (message, tool call, plan update, diff, done, error).
- **Motion_System**: The set of animations (pulse dots, orb glow, shimmer, blinking carets, typing dots, fade-in rows, spinners, progress bars) defined for the Studio_UI.
- **Reduced_Motion**: The user/operating-system preference exposed via the `prefers-reduced-motion: reduce` media query.
- **Design_Tokens**: The shared color, typography, spacing, and radius values that define the Studio_UI visual system.
- **Autonomy_Level**: The configured agent independence setting (for example `Low`, `Medium`, `High`) that governs how much the agent acts without approval.

## Requirements

### Requirement 1: Design system and tokens

**User Story:** As a Zoc AI user, I want a consistent dark visual system across every screen, so that the application feels like one cohesive, polished product.

#### Acceptance Criteria

1. THE Studio_UI SHALL render every screen using the dark Design_Tokens defined in the canvases: background `#0E0E11`, panel surfaces `#101014` and `#15151A`, borders `#1E1E23` and `#26262B`, primary text `#FAFAFA`, secondary text `#A1A1AA`, tertiary text `#71717A`, accent purple `#9B6AF1` and `#7C3AED`, success green `#34D399`, warning amber `#FBBF24`, and danger red `#F87171`.
2. THE Studio_UI SHALL apply the `Inter` font family to user-interface text, falling back to `system-ui` then the platform sans-serif default, and the `JetBrains Mono` font family to code, file paths, and metric values, falling back to `ui-monospace` then the platform monospace default.
3. WHERE a color, radius, or typography value is required by a component, THE Studio_UI SHALL resolve that value to a named shared Design_Token, and SHALL NOT use a color, radius, or typography literal that does not match a defined Design_Token value.
4. THE Studio_UI SHALL render the Title_Bar at a fixed height of 38 pixels containing window controls, the Zoc AI brand mark, the workspace path, the git branch indicator, the centered command-palette entry, panel toggles, and the Run or Running control.
5. WHILE the workspace path is wider than its allotted Title_Bar region, THE Studio_UI SHALL truncate the workspace path text and keep the git branch indicator, command-palette entry, panel toggles, and Run or Running control fully visible.

### Requirement 2: Sessions view

**User Story:** As a user returning to Zoc AI, I want to browse and resume past sessions, so that I can continue previous conversations and runs.

#### Acceptance Criteria

1. WHEN the Sessions activity is selected, THE Studio_UI SHALL display the Sessions_Sidebar and the Sessions_Dashboard.
2. THE Sessions_Sidebar SHALL group sessions under the headings Pinned, Today, Yesterday, and Earlier this week, in that order, omitting no heading and displaying each heading even when its group contains zero sessions.
3. WHERE a session is pinned, THE Sessions_Sidebar SHALL display that session in the Pinned group ahead of the Today, Yesterday, and Earlier this week groups.
4. THE Sessions_Dashboard SHALL display four statistic cards reporting Active sessions, Runs this week, Models used, and Tokens used, each showing a non-negative integer value and showing `0` when the underlying count is zero.
5. THE Sessions_Dashboard SHALL display filter tabs for All, Active, Pinned, and Archived, each showing a non-negative integer count of the Session_Cards that match that tab.
6. WHEN the user selects a filter tab, THE Sessions_Dashboard SHALL display only the Session_Cards matching the selected filter and hide all Session_Cards that do not match.
7. WHEN the user enters text in the session search field, THE Sessions_Dashboard SHALL display only the Session_Cards whose title or model metadata contains the entered text as a case-insensitive substring, and hide all Session_Cards that do not.
8. WHEN the user selects a sort option, THE Sessions_Dashboard SHALL order all currently displayed Session_Cards according to the selected option, producing a deterministic ordering for identical session data.
9. WHEN the user activates the Resume control on a Session_Card, THE Studio_UI SHALL open that session and display the workspace view for that session.
10. IF opening a session via the Resume control fails, THEN THE Studio_UI SHALL keep the Sessions_Dashboard displayed and present an error indication identifying that the session could not be opened.
11. WHEN the user activates the pin control on a Session_Card, THE Studio_UI SHALL toggle the pinned state of that session and persist the change across application restarts.
12. WHEN the user activates the delete control on a Session_Card, THE Studio_UI SHALL remove that session from the displayed list and persist the removal across application restarts.
13. IF deleting a session via the delete control fails, THEN THE Studio_UI SHALL retain that session in the displayed list and present an error indication identifying that the session could not be deleted.
14. WHEN the user activates the New session control, THE Studio_UI SHALL create a new session and make that session the active session.
15. WHEN no Session_Cards match the active filter tab and the entered search text, THE Sessions_Dashboard SHALL display an empty-state indication that no sessions match the current filter and search.

### Requirement 3: Agent-editing workspace layout

**User Story:** As a user watching the agent work, I want the editing workspace to reflect what the agent is doing, so that I can follow its progress in real time.

#### Acceptance Criteria

1. WHEN the workspace view is displayed, THE Studio_UI SHALL render the Activity_Bar, the File_Explorer, the Editor_View, the Bottom_Dock, and the Agent_Panel.
2. WHILE a Run is in the `running` state, THE Title_Bar SHALL display a Running indicator showing a spinner, the text "Running", and the elapsed run time formatted as HH:MM:SS.
3. WHILE a Run is in the `running` state, THE Title_Bar SHALL refresh the displayed elapsed run time at an interval of no more than 1 second.
4. WHEN a Run leaves the `running` state, THE Title_Bar SHALL remove the Running indicator within 1 second.
5. WHILE the agent is editing a file, THE File_Explorer SHALL display an "Agent is editing" badge identifying the file being edited.
6. WHEN the agent performs an edit to a file, THE Studio_UI SHALL update the agent-activity indicators to reflect that edit within 2 seconds of the edit.
7. THE File_Explorer SHALL display a per-file change badge of `A` for added files and `M` for modified files.
8. THE Editor_View SHALL display editor tabs for open files, marking modified files with a modified indicator.
9. WHILE the agent is editing lines in the active file, THE Editor_View SHALL highlight the edited lines and display an "Agent editing" marker on those lines.
10. WHILE the agent is actively typing into the Editor_View, THE Editor_View SHALL display a caret at the current edit position that alternates between visible and hidden at an interval of no more than 1 second.
11. THE Bottom_Dock SHALL provide Terminal, Problems, and Logs tabs and an agent-control toggle.
12. WHEN the user changes the agent-control toggle in the Bottom_Dock, THE Studio_UI SHALL update the agent-control state and reflect the new toggle position within 1 second.

### Requirement 4: Agent panel and chat experience

**User Story:** As a user directing the agent, I want a single rich agent panel for chatting and monitoring the run, so that I can communicate with the agent and see its status in one place.

#### Acceptance Criteria

1. THE Agent_Panel SHALL display a header containing the agent identity, a run-status indicator, and an overflow menu.
2. WHILE no Run is active, THE Agent_Panel SHALL display an idle status indicator and the model picker.
3. WHILE a Run is active, THE Agent_Panel SHALL display a status indicator showing whether the agent is `Planning` or `Building`.
4. THE Agent_Panel SHALL display a Run_Timeline that lists Plan steps and tool actions in execution order.
5. WHILE a Plan step is complete, THE Run_Timeline SHALL display a success checkmark and the step's elapsed time in seconds for that step.
6. WHILE a Plan step is in progress, THE Run_Timeline SHALL display a spinner for that step.
7. WHILE a Plan step is queued, THE Run_Timeline SHALL display a queued indicator for that step.
8. THE Agent_Panel SHALL display an in-progress task summary showing the count of completed tasks out of total tasks and a progress bar whose fill ratio equals completed tasks divided by total tasks.
9. THE Agent_Composer SHALL provide a message input accepting between 1 and 10,000 characters, an attachments control, a Plan/Build mode toggle, an Autonomy_Level selector, and a send control.
10. WHEN the user submits a non-empty message in the Agent_Composer while no Run is active, THE Studio_UI SHALL start a new Run using the submitted message.
11. WHEN the user submits a non-empty message in the Agent_Composer while a Run is active, THE Studio_UI SHALL hold the message as a pending queued message displayed in the Agent_Composer until the active Run reaches a terminal state (`completed`, `stopped`, or `error`).
12. THE Agent_Panel SHALL display a context-usage indicator reporting consumed context tokens and the context limit as a ratio of consumed tokens to the context limit.
13. IF the user activates the send control while the message input is empty or contains only whitespace, THEN THE Agent_Composer SHALL reject the submission, take no Run action, and indicate to the user that a non-empty message is required.
14. WHEN the active Run reaches a terminal state (`completed`, `stopped`, or `error`) and a pending queued message exists, THE Studio_UI SHALL start a new Run using the queued message and clear the pending queued message.
15. WHILE the consumed context tokens reach or exceed 90 percent of the context limit, THE Agent_Panel SHALL display the context-usage indicator in a warning state.

### Requirement 5: Diff-review workspace

**User Story:** As a user reviewing agent changes, I want a side-by-side diff with per-file controls, so that I can accept or reject the agent's work file by file.

#### Acceptance Criteria

1. WHEN the user opens the diff-review view, THE Studio_UI SHALL display the Diff_View, the Review_Toolbar, and the File_Explorer change summary.
2. THE File_Explorer SHALL display a "Review Pending" summary reporting the number of changed files and the total added and removed line counts, each as a non-negative integer.
3. THE Diff_View SHALL display removed lines marked with `−` and added lines marked with `+`, rendering removed lines, added lines, and unchanged lines with visually distinct backgrounds.
4. THE Review_Toolbar SHALL display the current change position as "Reviewing changes N of M", where N is the 1-based index of the currently selected change and M is the total count of changes, and SHALL display the per-file added and removed line counts.
5. WHEN the user activates the next-change control, THE Diff_View SHALL scroll to and select the next change and THE Review_Toolbar SHALL increase the displayed change position N by 1.
6. WHEN the user activates the previous-change control, THE Diff_View SHALL scroll to and select the previous change and THE Review_Toolbar SHALL decrease the displayed change position N by 1.
7. WHEN the user activates the Apply file control, THE Studio_UI SHALL apply the current file's changes to the workspace and remove that file from the set of pending reviews.
8. WHEN the user activates the Undo file control, THE Studio_UI SHALL discard the current file's changes and remove that file from the set of pending reviews.
9. IF the user activates the next-change control while the current change is the last change, THEN THE Review_Toolbar SHALL keep the displayed change position at the last change.
10. IF the user activates the previous-change control while the current change is the first change, THEN THE Review_Toolbar SHALL keep the displayed change position at the first change.
11. IF applying the current file's changes fails, THEN THE Studio_UI SHALL retain that file in the set of pending reviews and display an error detail indicating the apply failed.
12. WHEN the set of pending reviews becomes empty, THE Studio_UI SHALL display an all-reviewed state indicating there are no pending changes to review.

### Requirement 6: Motion system and animations

**User Story:** As a user, I want lively, meaningful animations that signal agent activity, so that the interface communicates state without being distracting or inaccessible.

#### Acceptance Criteria

1. THE Motion_System SHALL provide the following animations: status pulse dots, orb glow, shimmer, blinking carets, typing dots, fade-in rows, spinners, and progress bars.
2. WHILE the agent is producing streaming output, THE Agent_Panel SHALL display animated typing dots that repeat on a continuous loop with a cycle duration between 1 and 2 seconds.
3. WHEN a new Run_Timeline row appears, THE Run_Timeline SHALL animate that row with a fade-in transition that completes within 300 milliseconds, after which the row remains fully visible.
4. WHILE a Plan step is in progress, THE Run_Timeline SHALL display a shimmer animation on the active step container that repeats on a continuous loop with a cycle duration between 1 and 2 seconds.
5. WHILE a Run is active, THE Agent_Panel run-status indicator SHALL display a pulsing dot animation that repeats on a continuous loop with a cycle duration between 1 and 2 seconds.
6. WHERE the user has enabled Reduced_Motion, THE Studio_UI SHALL stop all continuous or looping animations (status pulse dots, orb glow, shimmer, blinking carets, typing dots, and spinners) and present the equivalent information in a single fixed visual state.
7. WHERE the user has enabled Reduced_Motion, THE Studio_UI SHALL limit any remaining transition (such as a row appearing) to a non-looping fade or instantaneous change that completes within 200 milliseconds.
8. WHERE the user has enabled Reduced_Motion, THE Studio_UI SHALL render the active, complete, and error state indicators using a static icon and a static color cue that distinguishes each state without motion.

### Requirement 7: Run lifecycle control

**User Story:** As a user supervising an agent run, I want working start, pause, and stop controls, so that I can interrupt or halt the agent reliably.

#### Acceptance Criteria

1. WHEN the user starts a Run, THE Studio_UI SHALL transition the Run_Lifecycle to `running` and assign the Run a run id within 1 second.
2. IF a Run cannot start, THEN THE Studio_UI SHALL keep the Run_Lifecycle in `idle`, SHALL NOT assign a run id, and SHALL display an error detail indicating the reason the Run could not start.
3. WHEN the user activates the pause control during a `running` Run, THE Studio_UI SHALL transition the Run_Lifecycle to `paused` and suspend consumption of further Agent_Events within 500 milliseconds.
4. WHEN the user activates the resume control during a `paused` Run, THE Studio_UI SHALL transition the Run_Lifecycle to `running` within 1 second and resume consumption of Agent_Events from the Agent_Event immediately following the highest processed sequence number.
5. WHEN the user activates the stop control during a `running` or `paused` Run, THE Studio_UI SHALL transition the Run_Lifecycle to `stopped` and terminate the Agent_Event stream within 1 second.
6. WHEN a Run's Agent_Event stream emits a done event, THE Studio_UI SHALL transition the Run_Lifecycle to `completed`.
7. WHILE the Run_Lifecycle is `paused`, THE Agent_Panel SHALL display a resume control in place of the pause control.
8. WHILE the Run_Lifecycle is `idle`, THE Agent_Panel SHALL disable the pause, resume, and stop controls; WHILE the Run_Lifecycle is `running`, THE Agent_Panel SHALL enable the pause and stop controls and disable the resume control; and WHILE the Run_Lifecycle is `paused`, THE Agent_Panel SHALL enable the resume and stop controls and disable the pause control.
9. WHEN the user starts a new Run while a previous Run is active, THE Studio_UI SHALL transition the previous Run to `stopped` and terminate its Agent_Event stream before assigning the new Run id.
10. WHEN a Run transitions to `stopped`, `completed`, or `error`, THE Studio_UI SHALL clear the active run id and set the run-status indicator to idle.

### Requirement 8: Agent event streaming correctness

**User Story:** As a user, I want the agent's streamed events to render accurately and in order, so that the displayed run state always matches the agent's actual progress.

#### Acceptance Criteria

1. WHEN an Agent_Event is received over the SSE stream, THE Studio_UI SHALL update the Run_Timeline to reflect that event within 500 milliseconds of receipt.
2. WHEN a message Agent_Event is received, THE Agent_Panel SHALL append the message if its identifier is not yet present, or update the existing message if its identifier already exists, preserving ascending order by sequence number.
3. WHEN a tool-call Agent_Event is received, THE Run_Timeline SHALL display the tool action labeled with its status as one of `pending`, `running`, `succeeded`, or `failed`.
4. WHEN a plan-update Agent_Event is received, THE Run_Timeline SHALL set each affected Plan step's status to the value carried in the event.
5. IF the SSE stream emits an error Agent_Event, THEN THE Studio_UI SHALL transition the Run_Lifecycle to `error`, display the error detail from the event in the Agent_Panel, and retain all Run_Timeline content already rendered before the error.
6. WHEN the Studio_UI subscribes to the Agent_Event stream for a session, THE Studio_UI SHALL request events occurring after the highest sequence number already processed for that session.
7. IF an Agent_Event arrives with a sequence number less than or equal to the highest sequence number already processed for the session, THEN THE Studio_UI SHALL discard that event and leave the Run_Timeline and Agent_Panel unchanged.
8. WHEN a Run is stopped by the user, THE Studio_UI SHALL stop applying subsequent Agent_Events from the terminated stream to the Run_Timeline.
9. IF the SSE stream is interrupted before the Run reaches a terminal Run_Lifecycle state, THEN THE Studio_UI SHALL re-subscribe requesting events after the highest sequence number already processed for that session, for up to 5 reconnection attempts, and SHALL transition the Run_Lifecycle to `error` with an error detail indicating the stream was lost if all attempts fail.

### Requirement 9: Plan and task progress accuracy

**User Story:** As a user, I want the plan and task progress to reflect real run state, so that the progress bar and step indicators are trustworthy.

#### Acceptance Criteria

1. WHEN the set of Plan steps changes or any Plan step status changes, THE Agent_Panel SHALL set the displayed completed-task count equal to the count of Plan steps currently in the `done` state.
2. WHILE the total count of Plan steps is greater than zero, THE Agent_Panel SHALL set the progress-bar fill ratio to the count of `done` Plan steps divided by the total count of Plan steps, expressed as a percentage clamped between 0% and 100% inclusive.
3. WHEN all Plan steps reach the `done` state, THE Agent_Panel SHALL display the progress bar at 100% fill and report the completed-task count equal to the total count of Plan steps.
4. THE Run_Timeline SHALL display the Autonomy_Level value taken from the current Run configuration, constrained to one of `Low`, `Medium`, or `High`, rather than a fixed value.
5. THE Run_Timeline SHALL display the active model identifier taken from the current Run configuration.
6. IF a Run has no Plan steps, THEN THE Agent_Panel SHALL display the progress bar at 0% fill and report a completed-task count of zero.
7. WHEN the current Run configuration's Autonomy_Level or active model identifier changes, THE Run_Timeline SHALL update the corresponding displayed value to match the current Run configuration.

### Requirement 10: Diff apply and undo correctness

**User Story:** As a user reviewing changes, I want apply and undo to behave consistently, so that accepted changes are written and rejected changes are discarded without affecting unrelated files.

#### Acceptance Criteria

1. WHEN the user applies a file's changes, THE Studio_UI SHALL write only that file's pending changes to the workspace and leave all other files unchanged.
2. WHEN the user undoes a file's changes, THE Studio_UI SHALL discard only that file's pending changes, remove that file from the set of pending reviews, and leave all other pending files unchanged.
3. WHEN a file's changes have been applied, THE Studio_UI SHALL update that file's File_Explorer change badge to reflect the applied state within 1 second of apply completion.
4. WHEN the last pending file is applied or undone, THE Studio_UI SHALL update the "Review Pending" summary to report a pending file count of zero.
5. IF applying a file's changes fails, THEN THE Studio_UI SHALL retain that file in the set of pending reviews, leave that file's workspace copy unchanged, and display an error indication that the apply failed.
6. WHEN the application is restarted after a file's changes were applied, THE Studio_UI SHALL report that file as applied after restart.
7. IF the user invokes apply or undo when there are no pending changes, THEN THE Studio_UI SHALL make no changes to any workspace file and display an indication that there are no pending changes to apply or undo.

### Requirement 11: Checkpoint and rollback

**User Story:** As a user, I want to roll back to a checkpoint after a wrong agent turn, so that I can recover from mistakes the agent makes.

#### Acceptance Criteria

1. WHEN the agent creates a Checkpoint during a Run, THE Run_Timeline SHALL display the Checkpoint entry showing its creation timestamp and a rollback control, ordered by creation time among the Run_Timeline entries.
2. WHEN the user activates a Checkpoint's rollback control, THE Studio_UI SHALL display a confirmation prompt indicating that all workspace changes made after that Checkpoint will be discarded.
3. WHEN the user confirms a Checkpoint rollback, THE Studio_UI SHALL restore the workspace to the state captured by that Checkpoint, discarding all file changes made after that Checkpoint, within 10 seconds.
4. WHILE a rollback is in progress, THE Studio_UI SHALL display a rollback-in-progress indicator and disable all rollback controls until the rollback resolves.
5. WHEN a rollback completes, THE Studio_UI SHALL update the File_Explorer change badges to reflect the restored workspace state.
6. IF a rollback fails or does not complete within 10 seconds, THEN THE Studio_UI SHALL leave the workspace in the state it was in before the rollback began and display an error detail indicating the rollback did not complete.

### Requirement 12: Panel layout and visibility controls

**User Story:** As a user, I want to toggle the side, dock, and agent panels, so that I can focus the workspace on what I need.

#### Acceptance Criteria

1. WHEN the user activates the sidebar toggle, THE Studio_UI SHALL invert the visibility of the File_Explorer panel, showing the File_Explorer when it is hidden and hiding it when it is visible.
2. WHEN the user activates the dock toggle, THE Studio_UI SHALL invert the visibility of the Bottom_Dock, showing the Bottom_Dock when it is hidden and hiding it when it is visible.
3. WHEN the user activates the agent-panel toggle, THE Studio_UI SHALL invert the visibility of the Agent_Panel, showing the Agent_Panel when it is hidden and hiding it when it is visible.
4. WHEN the user completes resizing a panel, THE Studio_UI SHALL persist the resulting panel size and restore that size on the next application start.
5. WHILE a panel is hidden, THE Studio_UI SHALL render the corresponding panel toggle in an inactive visual state that is visually distinct from its active state.
6. WHILE a panel is visible, THE Studio_UI SHALL render the corresponding panel toggle in an active visual state that is visually distinct from its inactive state.
7. WHILE the user is resizing a panel, THE Studio_UI SHALL constrain the panel size within defined bounds: the File_Explorer and Agent_Panel widths between 180 pixels and 600 pixels, and the Bottom_Dock height between 120 pixels and 80 percent of the available window height.
8. WHEN the Studio_UI restarts, THE Studio_UI SHALL restore the most recent visibility state of the File_Explorer, the Bottom_Dock, and the Agent_Panel.
