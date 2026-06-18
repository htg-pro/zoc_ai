# Requirements Document

## Introduction

The Chat Memory & Session System makes agent runs, the user messages that
trigger them, and the events they emit correctly associated, and makes session
connection deterministic. These requirements are derived from the approved
design document and are grounded in four user-observed symptoms in Zoc AI
("Zoc Studio"):

1. After typing a new message ("hi"), the agent answered a previously typed
   message ("hello") because a fresh run re-applied a prior run's events.
2. Opening a fresh chat auto-resumed the most-recent prior Agent Session instead
   of starting clean.
3. The system clock and chat timestamps disagreed, so sessions were mislabeled
   between Today / Yesterday / Earlier.
4. The agent acted on stale context (for example editing `src/App.tsx`) because
   recalled memory was not correctly scoped to the active session and working
   turn.

The root cause is the absence of a single authoritative association between a
user message, the run it triggered (`runId`), and the events that run emits,
compounded by three drifting sequence cursors, an unconditional auto-resume of
`sessions[0]`, a UTC-vs-local day-bucketing mismatch, and an under-specified
recall scoping contract. The requirements below specify the corrected behavior
so it can be exercised with property-based tests.

The requirement numbering is intentionally aligned with the forward
`Validates: Requirements X.Y` references already present in the design's
Correctness Properties section, so traceability holds in both directions.

## Glossary

- **Run**: A single agent execution triggered by one user message, identified
  by a backend-issued `runId`.
- **Run_Machine**: The frontend reducer (`run-machine.ts`) that holds
  `RunState`, including `runId`, `boundMessageId`, and `highestSeq`.
- **Run_Identity_Service**: The backend logic (`v1/agent_run.py`, `events.py`)
  that mints a `runId` for every run and stamps it on every emitted
  `AgentEvent`.
- **Event_Ingestor**: The frontend ingestion logic (`event-ingest.ts`,
  `decideIngest` / `upsertById`) that decides whether to apply, buffer, or
  discard an incoming `AgentEvent`.
- **Seq_Cursor**: The single per-session sequence authority (`seq-cursor.ts`)
  exposing `highestSeq` and `activeRunId`.
- **Session_Lifecycle_Resolver**: The pure frontend function
  (`session-lifecycle.ts`, `resolveSessionIntent`) that maps a lifecycle
  trigger to a `SessionIntent` (`fresh`, `resume`, or `select`).
- **Session_Query**: The frontend grouping logic (`session-query.ts`,
  `localDayIndex` / `groupSessions`) that buckets sessions by calendar day.
- **Recall_Service**: The backend `RecallService` / `MessageVectorStore`
  (`agent/recall.py`) that returns recalled message hits scoped to a session.
- **AgentEvent**: The streamed event envelope carrying `session_id`, `seq`, an
  optional `run_id`, `type`, and `payload`.
- **SessionIntent**: A discriminated union describing how a session connection
  should resolve: `fresh`, `resume`, or `select`.
- **Bound_Message**: The user `Message` whose `id` a run records as
  `boundMessageId` at start; the message that run answers.
- **Working_Window**: The set of message ids belonging to the current turn,
  passed to recall as `exclude_message_ids`.
- **Display_Timezone**: The wall-clock timezone shown to the user, expressed as
  an offset in minutes injected into `Session_Query`.

## Requirements

### Requirement 1: Run / Message Association

**User Story:** As a user of the agent chat, I want each agent run to answer
exactly the message I just sent, so that the agent never responds to an older
message such as "hello" when I typed "hi".

#### Acceptance Criteria

1. WHEN a run is started AND at least one user Message exists in the
   conversation, THE Run_Machine SHALL set `boundMessageId` to the id of the
   user Message with the latest append order, resolving ties (equal append
   order) in favor of the highest Message id, so that `boundMessageId` resolves
   to exactly one Message id.
2. IF an incoming AgentEvent has a non-null `run_id` that differs from the
   active `runId`, THEN THE Event_Ingestor SHALL discard that AgentEvent without
   applying it to the event list or to rendered output, and SHALL leave
   `highestSeq`, `activeRunId`, and `boundMessageId` unchanged.
3. WHEN a run is started, THE Run_Machine SHALL hold exactly one run in a
   `running` or `paused` lifecycle state, and that started run SHALL be the
   single active run identified by `runId`.
4. WHEN AgentEvents are ingested, including duplicate and out-of-order
   deliveries, THE Event_Ingestor SHALL apply each event whose id has not been
   previously applied at most once, SHALL ignore any event whose id was already
   applied, and THE Seq_Cursor SHALL keep `highestSeq` non-decreasing (each
   update sets `highestSeq` to the maximum of its current value and the applied
   event `seq`).
5. WHEN a run is started, THE Seq_Cursor SHALL preserve the existing
   `highestSeq` value as a non-decreasing floor and SHALL set `activeRunId` to
   the new `runId`.
6. WHEN an entry is upserted into the event list by id, THE Event_Ingestor SHALL
   produce a list ordered ascending by `seq`, resolving ties (equal `seq`) by
   ascending id, containing that entry exactly once.
7. WHEN an incoming AgentEvent has a non-null `run_id` equal to the active
   `runId`, THE Event_Ingestor SHALL apply that AgentEvent to the run bound to
   `boundMessageId`, so that rendered output is associated with the user Message
   identified by `boundMessageId` and not with any earlier user Message.
8. IF a run is started while no user Message exists in the conversation, THEN THE
   Run_Machine SHALL leave `boundMessageId` unset (null) and SHALL NOT start an
   active run, retaining the prior run/message association unchanged.

### Requirement 2: Session Lifecycle

**User Story:** As a user, I want opening a new chat to start a clean session,
so that the application never auto-resumes an old Agent Session I did not
choose.

#### Acceptance Criteria

1. WHEN the Session_Lifecycle_Resolver receives a `new-chat` trigger, THE
   Session_Lifecycle_Resolver SHALL return a SessionIntent of kind `fresh`,
   regardless of the number of sessions in the current session list (including
   zero) and regardless of whether `lastActiveId` is set or names an existing
   session.
2. WHEN the Session_Lifecycle_Resolver receives an `app-open` trigger AND
   `lastActiveId` is set AND `lastActiveId` names a session present in the
   current session list, THE Session_Lifecycle_Resolver SHALL return a
   SessionIntent of kind `resume` whose `sessionId` equals `lastActiveId`; IF
   the Session_Lifecycle_Resolver receives an `app-open` trigger AND
   (`lastActiveId` is unset, `lastActiveId` names no session in the current
   session list, or the current session list is empty), THEN THE
   Session_Lifecycle_Resolver SHALL return a SessionIntent of kind `fresh`.
3. WHEN the Session_Lifecycle_Resolver receives a `select` trigger naming a
   session id that is present in the current session list, THE
   Session_Lifecycle_Resolver SHALL return a SessionIntent of kind `select`
   whose `sessionId` equals the requested id.
4. IF the Session_Lifecycle_Resolver receives a `select` trigger naming a
   session id that is not present in the current session list (including when
   the current session list is empty), THEN THE Session_Lifecycle_Resolver SHALL
   return a SessionIntent of kind `fresh`.
5. WHEN the Session_Lifecycle_Resolver receives a `delete-active` trigger, THE
   Session_Lifecycle_Resolver SHALL return a SessionIntent of kind `fresh`,
   regardless of the number of remaining sessions in the current session list
   and regardless of the value of `lastActiveId`.

### Requirement 3: Time Consistency

**User Story:** As a user, I want sessions grouped by the wall-clock day I see,
so that Today, Yesterday, and Earlier labels match my actual clock rather than
UTC.

#### Acceptance Criteria

1. WHEN computing the day bucket for a session timestamp, THE Session_Query SHALL
   compute the day index from the session `updated_at` value using a
   Display_Timezone offset (in minutes) and a current-time value that are both
   passed in as function arguments, and SHALL NOT read the host system clock or
   environment timezone inside the function, so that identical inputs always
   produce identical day indices.
2. WHEN two non-pinned sessions have `updated_at` values that resolve to the same
   Display_Timezone calendar day, THE Session_Query SHALL assign them equal day
   indices and place each non-pinned session into exactly one day bucket, using
   the same Display_Timezone offset applied to the injected current time as is
   applied to each session.
3. WHEN assigning a non-pinned session to a labeled bucket, THE Session_Query
   SHALL label it "Today" if its day index equals the current-time day index,
   "Yesterday" if its day index equals the current-time day index minus 1, and
   "Earlier" if its day index is less than the current-time day index minus 1,
   where each Display_Timezone calendar day spans the half-open local-time
   interval [00:00:00.000, 24:00:00.000) and a timestamp exactly at local
   midnight is treated as the first instant of the day it begins.
4. IF the session `updated_at` value cannot be parsed by `Date.parse` (the parse
   result is NaN), THEN THE Session_Query SHALL assign that session a day index
   of NEGATIVE_INFINITY and place it in the "Earlier" bucket, without throwing an
   error and without affecting the day indices assigned to other sessions.

### Requirement 4: Session-scoped Recall

**User Story:** As a user, I want recalled context limited to my current session
and excluded from the message I am currently sending, so that the agent does not
act on stale context drawn from other sessions or the current turn.

#### Acceptance Criteria

1. WHEN the Recall_Service returns hits for a session, THE Recall_Service SHALL
   return only hits that were stored under that same session id, and SHALL NOT
   return any hit stored under a different session id.
2. WHEN the Recall_Service is given a Working_Window exclusion set, THE
   Recall_Service SHALL exclude every hit whose `message_id` is in that set and
   SHALL return only hits whose score is greater than or equal to the configured
   minimum score (default 0.15).
3. IF the recall query is empty or contains only whitespace, THEN THE
   Recall_Service SHALL return zero hits.
4. WHEN the Recall_Service returns hits, THE Recall_Service SHALL order them by
   descending score and SHALL return at most the configured `top_k` number of
   hits (default 3).
5. IF the configured `top_k` is less than or equal to zero, THEN THE
   Recall_Service SHALL return zero hits.
