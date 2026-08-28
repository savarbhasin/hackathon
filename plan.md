# Production architecture plan

## Decision

Mission Control will use four distinct pieces:

- Convex is the application database and realtime delivery layer for the frontend.
- Redis stores BullMQ queue data. It is not the source of truth for missions, conversations, tasks, or run results.
- BullMQ handles job delivery, retries, stalled jobs, concurrency, and scheduling.
- A long-running Node.js worker consumes BullMQ jobs and keeps TrueForge streams open until a turn completes or pauses.

This separation is deliberate. Convex is excellent at reactive application state. BullMQ is built for Node.js job delivery. The worker owns the one requirement neither the browser nor a short server function can satisfy: maintaining a live TrueForge subscription for as long as the turn needs it.

## Goals

- Agent work continues after the user closes the website or switches conversations.
- More than one conversation can run at the same time.
- A worker restart does not silently lose a run.
- Board and chat screens update immediately after relevant database writes.
- Browser connections never poll the full database.
- Human approval and question pauses remain durable.
- Schedules survive service restarts.
- Every retry is safe, observable, and bounded.
- The application can run more than one web or worker instance.

## Non-goals

- Redis will not contain the canonical copy of product data.
- Convex actions will not hold long TrueForge streams.
- Convex is the sole application data store; Redis is only the BullMQ delivery layer.
- We will not claim exactly-once execution. BullMQ delivery is at least once, so run handling and external actions must be idempotent.
- We will not split the product into many small services. The first production version needs one repository and three deployable Node.js processes.
- Multi-user accounts, workspaces, memberships, and tenant isolation are later product work.

## System shape

```text
Browser
   |
   | Convex queries and mutations
   v
Convex database <-------------------------------+
   |                                             |
   | run created or resumed                     | run events, messages,
   v                                             | status, output, pauses
Next.js enqueue path                             |
   |                                             |
   | BullMQ job containing only runId            |
   v                                             |
Redis and BullMQ                                 |
   |                                             |
   | one worker claims the job                   |
   v                                             |
Long-running Node.js worker ---------------------+
   |
   | live stream subscription
   v
TrueForge
   |
   | tool calls
   v
Mission Control MCP and external connectors
```

Deployable processes:

- `web`: Next.js pages, authentication, and short request handlers.
- `worker`: BullMQ worker, TrueForge stream consumer, and run recovery.
- `mcp`: stateless Mission Control MCP tools used by TrueForge.

Hosted dependencies:

- Convex Cloud for the application database and reactive queries.
- A dedicated managed Redis instance for BullMQ.
- A hosted TrueForge service reachable by the worker and MCP service.

## Ownership rules

### Convex owns

- Missions and tasks
- Conversations and messages
- Agent profiles
- Documents and handoffs
- Schedules as user-facing configuration
- Agent run lifecycle
- Pending approvals and questions
- Durable run events and final results

### Redis and BullMQ own

- Waiting, active, delayed, completed, and failed queue entries
- Worker locks and lock renewal
- Retry timing and backoff
- Queue concurrency
- Stalled-job recovery
- Schedule delivery after schedule configuration has been synchronized

### The worker owns

- Opening and consuming TrueForge streams
- Merging TrueForge delta events
- Persisting normalized events into Convex
- Renewing the BullMQ job lock by keeping the Node event loop healthy
- Resubscribing to an existing TrueForge turn after a recoverable failure
- Mapping provider states into Mission Control run states
- Graceful cancellation and shutdown

## Convex data model

The initial Convex schema should cover the application records and add explicit run state.

### `agentRuns`

```text
id
kind                 orchestrator | specialist | schedule
conversationId       optional
taskId               optional
scheduleId           optional
status               queued | enqueued | connecting | running |
                     waiting_for_user | waiting_for_approval |
                     completed | failed | cancelled
sessionId            optional TrueForge session ID
turnId               optional TrueForge turn ID
providerSequence     optional numeric turn.done cursor committed with lifecycle outcome
attempt              current execution attempt
claimedBy            worker identity
startedAt
updatedAt
finishedAt
errorCode
errorMessage
input                 validated structured input
output                normalized final output
```

Indexes:

- by conversation and creation time
- by task and creation time
- by status and update time
- by TrueForge session and turn ID

### Provider event replay

Mission Control does not store a per-event journal. TrueForge remains the replay authority for turn events:

- workers merge base and delta events in memory during the active subscription;
- a pre-terminal crash re-subscribes without a cursor and replays the turn from TrueForge's server-side buffer;
- a numeric `turn.done` cursor is stored atomically with the final or paused lifecycle state;
- changing to a new resume turn clears the prior turn's cursor.

### Other tables

- `missions`
- `tasks`
- `taskEvents`
- `documents`
- `conversations`
- `chatMessages`
- `agentProfiles`
- `schedules`
- `pendingActions`
- `settings`

## Queue contract

Use one BullMQ queue named `agent-runs` initially. Different run types can use BullMQ job names while sharing worker infrastructure:

```text
orchestrator.start
orchestrator.resume
specialist.start
specialist.resume
schedule.fire
```

The queue payload stays small:

```json
{
  "runId": "convex-run-id"
}
```

The worker reads the current input and status from Convex after claiming the job. Redis must not carry prompts, documents, pending actions, or result history as the only copy.

Queue defaults:

- `jobId` is the Convex run ID.
- Retry only failures classified as recoverable.
- Use exponential backoff with jitter.
- Retain a bounded number of completed jobs for debugging.
- Retain failed jobs longer for manual inspection and retry.
- Emit and monitor `stalled`, `failed`, `error`, and lock-renewal events.
- Keep worker concurrency configurable by environment.
- Use separate queue and worker Redis connections with the settings BullMQ requires.

The Redis deployment must use `maxmemory-policy=noeviction`. Queue keys cannot be evicted like cache entries. Use TLS, authentication, persistence, backups appropriate to the managed provider, and a Redis instance that is not shared with disposable application caching.

## Creating a run without losing it

Convex and Redis cannot participate in one transaction. The enqueue path therefore needs idempotency and reconciliation.

1. A Convex mutation writes the user message and creates an `agentRuns` record with `status=queued`.
2. The server adds a BullMQ job using `jobId=runId`.
3. After Redis accepts the job, a Convex mutation changes the run to `enqueued`.
4. If enqueue fails, the run remains `queued` with an enqueue error that the UI can show and retry.
5. A reconciler periodically finds old `queued` runs and adds their stable BullMQ job IDs again.
6. Adding the same active job ID again must not create a second execution.

Failure cases:

- If the process dies before adding the job, reconciliation adds it later.
- If the process dies after adding the job but before marking it enqueued, the worker can still claim it. Reconciliation uses the same job ID.
- If a duplicate reaches a worker, the Convex claim mutation rejects a run that is already owned or terminal.

## Worker execution contract

### Claim

Before contacting TrueForge, the worker calls an internal Convex mutation that conditionally moves the run into `connecting` and records the worker and attempt. A terminal run or an attempt already owned by another live worker is a no-op.

BullMQ owns the active-job lease. Convex records ownership for observability and conditional state changes, not as a second queue lock.

### Start

For a new run, the worker:

1. Creates or validates the TrueForge session.
2. Persists the session ID before starting a turn when the provider API permits it.
3. Starts the turn and persists the turn ID as soon as TrueForge emits it.
4. Consumes the stream until `turn.done`, a durable pause, cancellation, or a classified failure.

### Resume

Approval and question responses create a new `orchestrator.resume` or `specialist.resume` job. Human waiting time must not keep a BullMQ job active.

The worker validates the pending action from Convex, sends a provider resume input in a new turn, and clears the pending action only after TrueForge confirms the resume completed or produced a new pause.

### Event persistence

- Merge TrueForge delta fragments before reading tool calls or text.
- Persist provider lifecycle events with a deduplication key.
- Buffer text deltas and flush them every 150 to 300 milliseconds or after a size threshold.
- Do not make board queries depend on token-delta records.
- Persist final messages, usage, pause actions, and run status before acknowledging the BullMQ job.

### Completion

- `turn.done` with no required action moves the run to `completed`.
- A required approval moves the run to `waiting_for_approval`.
- A required answer or connector authentication moves it to `waiting_for_user`.
- A provider cancellation moves it to `cancelled` or back to a retryable state according to an explicit policy.
- A recoverable infrastructure error updates the run and throws so BullMQ retries it.
- An invalid input or permanent provider error moves the run to `failed` without another automatic retry.

### Worker crash

BullMQ will mark a job stalled when its worker stops renewing the lock. Another worker may process it again. On re-entry:

1. Load the run from Convex.
2. If it is terminal, finish the duplicate job without contacting TrueForge.
3. If it has a session and turn ID, subscribe to that turn from its persisted cursor when one is valid; otherwise replay from the beginning of TrueForge's server-side buffer.
4. If TrueForge cannot resume an abandoned turn, reconcile its current state before deciding whether to create another turn.
5. Never repeat an irreversible external action without an idempotency key or confirmed provider state.

This recovery behavior is a go or no-go requirement. Test it against the running TrueForge server before production releases.

## Realtime frontend

The frontend uses scoped Convex queries:

- Board page subscribes to missions, tasks, and run status.
- Conversation page subscribes to messages and the active run for one conversation.
- Conversation sidebar subscribes only to conversation summaries and their latest run status.
- Task page subscribes to one task, its normalized activity, documents, and pending action.
- Schedules page subscribes to schedule configuration and latest delivery state.

The old `/api/stream` polling endpoint has been removed.

Use one shared `ConvexReactClient` across Next.js page navigation. Switching conversations changes subscriptions and never aborts an agent run.

## Schedules

Convex stores the user-facing schedule record. BullMQ delivers scheduled runs.

1. Creating or editing a schedule writes the validated schedule to Convex.
2. A short synchronization path creates or updates a BullMQ Job Scheduler using the Convex schedule ID as its stable identity.
3. Each firing creates a new Convex run before agent execution.
4. `lastRunAt` changes only after the run reaches a real terminal or waiting state chosen by the product contract.
5. A reconciler compares enabled Convex schedules with BullMQ schedulers and repairs drift.

The MCP process validates cron expressions only. BullMQ owns schedule delivery.

## Idempotency rules

BullMQ provides at-least-once processing. These rules are mandatory:

- Convex run ID is the BullMQ job ID.
- Convex mutations use expected status and attempt checks.
- Provider events use provider ID or sequence deduplication.
- `mark_done` is idempotent for a task and run.
- Document creation from an agent uses a stable operation key when retried.
- External connector calls use provider-supported idempotency keys where available.
- Approval and answer submissions carry the pending-action selector and can be consumed once.
- Completion logic can run more than once without dispatching successors twice.
- Schedule firings use a stable schedule ID plus intended fire time to prevent duplicate runs.

## Production process requirements

### Web

- Short requests only
- No detached execution promises
- Basic rate limits for run creation and human responses
- Readiness check for Convex and the enqueue path

### Worker

- At least one continuously running instance
- Configurable concurrency
- Graceful `SIGTERM` handling
- Stop claiming new work during shutdown
- Allow active streams a bounded grace period to finish or checkpoint
- Health endpoint for process state
- Readiness based on Redis, Convex, TrueForge, and MCP reachability
- Structured logs containing run ID, job ID, session ID, turn ID, worker ID, and attempt

### MCP

- Stateless request handling
- Authentication between TrueForge and MCP
- No schedule ownership
- No background worker ownership
- Readiness check that verifies required dependencies, not only that the HTTP server is listening

## Local development

Expected processes:

```text
npm run dev
npm run dev:worker
npm run dev:mcp
npx convex dev
docker compose up redis
```

Local Redis must use the same no-eviction policy expected in production. Development scripts should give each service a clear health check and fail with readable dependency errors.

## Implementation phases

### Phase 0: prove the risky assumptions

Build isolated spikes before trusting the runtime in production.

1. Convex realtime spike
   - Write a task status mutation.
   - Confirm two open browsers update without `/api/stream`.
   - Measure update latency and query recomputation.
2. Background TrueForge spike
   - Enqueue one run through BullMQ.
   - Let the worker hold the TrueForge stream.
   - Close the browser and confirm the run continues.
3. Recovery spike
   - Kill the worker mid-turn.
   - Start another worker.
   - Confirm it can subscribe to the existing TrueForge turn and continue from the saved cursor.
4. Pause spike
   - Reach an approval or question pause.
   - Finish the BullMQ job.
   - Submit the human response later through a new resume job.
5. Failure spike
   - Restart Redis, Convex connectivity, MCP, and TrueForge independently.
   - Confirm every run ends as completed, waiting, retrying, or visibly failed. No run may remain falsely active.

Go or no-go condition: do not ship the worker until the recovery spike proves how TrueForge behaves after its subscriber disappears.

### Phase 1: infrastructure and contracts

- Add Convex project configuration and schema.
- Add managed Redis configuration and local Redis compose service.
- Add BullMQ queue producer and worker entry point.
- Add environment validation for web, worker, and MCP processes.
- Define run status transitions in one shared module.
- Add enqueue reconciliation and queue event monitoring.

### Phase 2: background orchestrator conversations

- Store conversations and messages in Convex.
- Create runs through the durable enqueue path.
- Move TrueForge orchestrator streaming into the worker.
- Persist streamed output and pause actions in Convex.
- Replace global frontend `busy` state with per-conversation run status.
- Support switching and opening new conversations while prior runs continue.

### Phase 3: specialist task engine

- Store missions, tasks, task events, documents, and agent profiles in Convex.
- Keep provider turns in BullMQ workers, never detached from web requests.
- Preserve dependency checks, handoff documents, approvals, questions, and successor dispatch.
- Make successor dispatch idempotent.
- Move retry and cancellation into the shared run engine.

### Phase 4: realtime UI cutover

- Feed the board with Convex queries.
- Feed conversation history with scoped Convex queries.
- Replace task detail polling or refetch behavior with subscriptions.
- Keep `/api/stream` and database polling code absent.
- Verify subscription scope so token writes do not rerender unrelated pages.

### Phase 5: schedules

- Store schedule records in Convex.
- Synchronize enabled schedules to BullMQ Job Schedulers.
- Create scheduled agent runs through the same run contract.
- Keep Cron ownership out of the MCP process.
- Add schedule drift reconciliation and visible failure state.

### Phase 6: production cutover

- Run the full product against the production Convex deployment.
- Verify row relations, message ordering, task dependencies, pending actions, and document links.
- Verify worker recovery, pause/resume, schedule delivery, and external-action approval gates.
- Switch traffic after the production smoke tests pass.

### Phase 7: production hardening

- Add global concurrency and cost limits.
- Add queue depth, run age, failure rate, retry count, and stalled-job alerts.
- Add dead-letter review and manual retry controls.
- Add deployment shutdown drills and dependency outage drills.
- Add retention policies for queue jobs, run events, messages, and logs.
- Document backup and restore for Convex and Redis.

## Testing

### Unit tests

- Run state transition validation
- Event deduplication
- Queue job ID construction
- Error classification
- Resume input construction
- Schedule firing identity
- Successor dispatch idempotency

### Integration tests

- Convex mutation to BullMQ enqueue
- BullMQ worker to mocked TrueForge stream
- Delta merging and throttled persistence
- Approval and question resume
- Worker crash and stalled-job recovery
- Duplicate queue delivery
- Redis reconnect
- Convex write failure during an active stream

### End-to-end tests

- Start a conversation, close the browser, reopen it, and see the completed response.
- Run two conversations simultaneously.
- Start independent specialist tasks concurrently.
- Approve one paused run while another continues.
- Restart the web process without affecting active runs.
- Restart a worker and recover an active run.
- Update a task and observe all open boards change without polling.
- Fire a schedule once and verify one run exists for its intended fire time.

## Observability

Every run needs one traceable identity across systems:

```text
Convex run ID = BullMQ job ID
```

Logs and metrics must include:

- conversation or task ID
- run ID
- BullMQ job name and attempt
- worker ID
- TrueForge session and turn ID
- last provider cursor
- current run status
- elapsed time
- final error classification

Required alerts:

- Queue depth above threshold
- Oldest waiting job above threshold
- Run active longer than its policy allows
- Repeated stalled jobs
- Dead-letter growth
- Worker count at zero
- Redis memory or eviction-policy mismatch
- Convex mutation failures
- TrueForge or MCP readiness failure

## Security

- Keep Redis private and require TLS and authentication.
- Keep queue payloads free of secrets and large prompts.
- Store provider credentials only in service environment variables.
- Restrict worker-only Convex functions from browser clients.
- Authenticate TrueForge calls to the MCP service.
- Preserve the existing approval requirement for irreversible tools.
- Record who approved, denied, answered, retried, or cancelled a run.

Multi-user authentication and tenant isolation are intentionally deferred. They should be added as a separate product project if Mission Control becomes shared by multiple people.

## Rollout and rollback

- Develop on a dedicated branch.
- Enable the new path in a test deployment first.
- Do not run the same user request through both execution paths.
- Roll back application traffic before accepting new writes if the Convex deployment fails.

## Decisions still required

- Managed Redis provider and hosting region
- Worker hosting platform
- Convex Cloud region and plan
- Maximum worker concurrency
- Maximum automatic attempts per run type
- Retention period for completed and failed BullMQ jobs
- Retention period for detailed run events
- Whether TrueForge can resume a turn after all subscribers disconnect
- Cancellation behavior for an active TrueForge turn

## Acceptance criteria

The architecture is ready for production rollout when all of these are true:

- Closing every browser does not stop active agent work.
- Switching conversations does not affect any active run.
- The board has no one-second polling loop.
- A task or message write appears in subscribed clients without manual refetching.
- A web restart does not affect active workers.
- A worker crash leads to a safe retry or a visible permanent failure.
- Duplicate BullMQ delivery does not duplicate a run, document, successor task, or external action.
- Human pauses survive browser, web, worker, and MCP restarts.
- Schedules produce at most one logical run for each intended fire time.
- Queue, worker, Convex, TrueForge, and MCP failures are visible in logs and monitoring.

## First implementation checkpoint

Review the recovery evidence before production releases. If a replacement worker cannot resume an abandoned turn, add an explicit provider-session recovery policy before shipping the worker.
