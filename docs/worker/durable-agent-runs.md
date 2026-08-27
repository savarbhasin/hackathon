# Durable `agent-runs` worker

The production path uses Convex for durable run state and BullMQ for delivery. The worker owns each live TrueForge stream.

## Contract

- Convex `agentRuns` and `runEvents` are the source of truth.
- BullMQ queue name is `agent-runs`.
- Every queue payload is exactly `{ runId }`; its BullMQ `jobId` is the same Convex run ID.
- Redis carries delivery and locking only. It never carries prompts, provider credentials, actions, output, or the canonical run state.
- A worker claims a run with its expected attempt, persists a new TrueForge session **before** creating a turn, creates the turn with `stream:false`, persists the turn ID, then subscribes from the durable provider cursor.
- Every event is persisted before advancing the provider cursor. A terminal result or durable pause is written before the BullMQ processor resolves.
- A recoverable stream failure calls the guarded `releaseForRetry` transition, preserves session/turn/cursor, and throws to invoke BullMQ's bounded retry. A later job gets the latest snapshot and claims with its exact attempt before attaching to that provider turn.

## Environment

Keep actual values only in `.env.local`; never print or commit them.

```bash
REDIS_URL=rediss://:<token>@<host>:<port>
CONVEX_URL=https://<deployment>.convex.cloud
TRUEFORGE_BASE_URL=http://localhost:8790 # defaults to this local URL when omitted
WORKER_CONCURRENCY=2
```

`REDIS_URL` must be the raw TCP/TLS `rediss://` endpoint in managed/production environments. Upstash REST URL/token credentials are not usable by BullMQ. For the checked-in local Docker Redis only, non-production workers may use `redis://127.0.0.1:6390`; all other insecure URLs are rejected. The worker validates this before it starts. Its ioredis connection intentionally uses `maxRetriesPerRequest: null` for BullMQ lock renewal; producer connections fail quickly.

For local Redis, start the repository's no-eviction service and then set the local URL:

```bash
docker compose up redis
export REDIS_URL=redis://127.0.0.1:6390
```

## Commands

Start prerequisites (TrueForge, Convex deployment, and Redis must be available):

```bash
npm run dev:worker
# or without watch:
npm run worker
```

Create and enqueue a run. `external-id` is an application idempotency key; the printed `runId` is the Convex ID and the stable BullMQ job ID.

```bash
npm run enqueue:run -- \
  --external-id drill-$(date +%s) \
  --kind specialist \
  --agent researcher \
  --message "Reply with one short sentence about durable workers."
```

The CLI prints IDs and queue status only, not prompt content or connection settings.

## Drills

### Browser-independent start

1. Start `npm run dev:worker`.
2. Enqueue a run with the command above.
3. Close the browser (or do not open one); observe `job.active` then `run.completed`, `run.paused`, `run.cancelled`, or `run.failed` worker JSON logs.
4. Inspect the corresponding Convex `agentRuns` and `runEvents` records.

### Worker-kill recovery

1. Enqueue a deliberately longer-running run.
2. Wait for `runId`, `sessionId`, `turnId`, and `providerSequence` to appear in Convex.
3. Send `SIGTERM` to the worker process. The worker aborts the subscription, guarded-releases the run, and stops accepting work.
4. Start another `npm run dev:worker`. The retry gets the latest run snapshot, claims only the matching attempt, and attaches via `subscribeToTurn(afterSequenceNumber)`.
5. Verify no duplicate `runEvents` provider ID/sequence and one final run state.

### Pause and resume

1. Use an agent/tool configuration that produces an approval or answer pause.
2. Verify the job completes with `waiting_for_approval` or `waiting_for_user`; no active BullMQ job remains during human wait time.
3. Submit the human response through the application `queueResumeAndEnqueue` producer. It first calls the durable `queueResume` mutation, then removes only the retained completed pause-delivery before adding the same stable job ID.
4. The newly claimed worker creates a new non-streaming turn, checkpoints it, calls `acceptResume`, then streams that turn to another terminal/pause state.

### Failure drills

- **Redis**: stop/revoke Redis briefly during an active stream. Confirm the job retries or becomes visibly failed after its bounded attempts; never leave a falsely completed Convex run.
- **TrueForge**: stop the server or block access during an active stream. Confirm guarded release plus attach-on-retry after it returns.
- **Convex**: block the worker's Convex access. Event/cursor checkpoint failure must prevent job acknowledgement; restoration allows retry from the prior cursor.
- **MCP**: stop the MCP server before a tool call. The terminal provider result must become a durable pause/failure, not an unrecorded active run.

## Stable job-ID behavior

BullMQ retains completed jobs for one hour and failed jobs for one day. Re-adding a retained `jobId` returns the existing delivery and is treated as a no-op. A pause needs another delivery for the same logical Convex run, so the resume producer first verifies Convex has returned it to `queued`/`enqueued`, then removes **only** its retained completed pause delivery before re-adding the same `runId`. Terminal run deliveries are never replaced; use a new Convex run for a manual retry.
