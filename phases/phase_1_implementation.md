# Phase 1 Implementation — Durable Agent Runs

## What Phase 1 delivered

A production BullMQ worker that consumes agent runs from a durable Convex queue, holds live TrueForge streams, persists every event, and survives worker restarts — without requiring an open browser tab.

## Architecture

```
Browser → Convex mutations → Redis/BullMQ queue → Worker → TrueForge → Convex
                                          ↑                         |
                                          └─── events, status, ────┘
                                               output, pauses
```

Three deployable processes:
- **web**: Next.js pages and short request handlers (existing, untouched)
- **worker**: BullMQ consumer, TrueForge stream owner, run recovery
- **mcp**: Mission Control MCP tools used by TrueForge (existing, untouched)

The durable Convex/BullMQ execution path is the supported execution path.

## What was built

### 1. Convex foundation

**`convex/agentRuns.ts`** — 16 mutations/queries implementing the full run lifecycle:

| Function | Purpose |
|---|---|
| `create` | Idempotent insert with `externalId` dedup, status `queued` |
| `markEnqueued` | `queued` → `enqueued` after Redis accepts the job |
| `get` / `getByExternalId` | Read by Convex ID or application key |
| `claim` | Worker claims with attempt guard; returns full snapshot including `resumeInput` |
| `checkpointSession` | Persist TrueForge `sessionId` (safe start order: session before turn) |
| `checkpointSessionTurn` | Persist `turnId`, transition to `running` |
| `checkpointProviderCursor` | Monotonic cursor advance (forward-only guard) |
| `appendProviderEvent` | Idempotent event insert with `providerEventId` dedup |
| `waitForUser` / `waitForApproval` | Durable pause with `pendingActions` |
| `releaseForRetry` | Controlled failure: reset to `queued` preserving checkpoints |
| `queueResume` / `acceptResume` | Two-step resume: store response → clear pause after turn checkpoint |
| `complete` / `fail` / `cancel` | Terminal transitions |

**`convex/schema.ts`** — `agentRuns` and `runEvents` tables with 15 indexes (by externalId, conversation, task, status+updatedAt, session+turn, run+sequence, run+providerEventId).

### 2. BullMQ queue infrastructure (`src/lib/queue/`)

| File | Role |
|---|---|
| `types.ts` | Shared types: 9-state FSM, `AgentRunStore` interface (15 methods), `RecoverableRunError` |
| `env.ts` | Validates `REDIS_URL`, `CONVEX_URL`, `TRUEFORGE_BASE_URL` |
| `redis.ts` | IORedis factory: `maxRetriesPerRequest: null` for workers/events, `1` for producers |
| `agent-runs.ts` | Queue + QueueEvents creation, `enqueueAgentRun` (stable `jobId = runId`), `replaceCompletedDeliveryForResume` |
| `convex-agent-runs.ts` | Server-side `AgentRunStore` implementation calling Convex via `ConvexHttpClient` |
| `producer.ts` | Durable `createAndEnqueueDurableRun`, `queueResumeAndEnqueue`, `enqueueAcceptedResume` |
| `run-worker.ts` | Core `processAgentRun()`: claim → session → turn → subscribe → persist events → classify result |
| `log.ts` | Structured JSON logger (`agent-runs-worker` service) |

### 3. Worker entrypoint (`worker/agent-runs.ts`)

- Configurable `WORKER_ID` and `WORKER_CONCURRENCY` (default 2)
- Structured lifecycle logs: `worker.ready`, `job.active`, `run.completed`, `run.failed`, `job.completed`
- Graceful `SIGTERM`/`SIGINT` shutdown: abort active subscriptions, release owned runs, wait for checkpoint
- No detached promises — every checkpoint awaited before job resolution

### 4. CLI tool (`worker/enqueue-agent-run.ts`)

```bash
npm run enqueue:run -- \
  --external-id <key> \
  --kind specialist \
  --agent researcher \
  --message "Your prompt"
```

Prints only IDs and queue status. No prompts, no credentials.

### 5. Redis runtime

- **`docker-compose.yml`**: Redis 7 Alpine, `noeviction`, healthcheck, port `127.0.0.1:6390` (local dev fallback only)
- **`scripts/redis-preflight.mjs`**: Credential-safe preflight — TLS connect, AUTH, PING, `maxmemory-policy` check (with `INFO memory` fallback for Upstash)
- **Upstash verified live**: TLS auth, PING/PONG, `noeviction`, Redis 8.2.0

### 6. Documentation (6 files)

| File | Content |
|---|---|
| `docs/worker/durable-agent-runs.md` | Design doc, contract, commands, drill procedures |
| `docs/redis-preflight.md` | Redis setup, preflight checks, BullMQ connection notes |
| `docs/trueforge-sdk-recovery-research.md` | 8-question SDK research: resumption, cursors, deltas, cancellation, pauses, terminal states |
| `docs/convex-realtime-spike.md` | Convex realtime spike procedure |
| `docs/spikes/trueforge-recovery.md` | TrueForge detach/recovery probe documentation |

## Bugs fixed during implementation

1. **`claim` typecheck** (`convex/agentRuns.ts:64`): inline spread of nullable doc made `status` inferred-optional — extracted and narrowed before spread
2. **QueueEvents `maxRetriesPerRequest`** (`redis.ts`): `events` role used `1` but needs `null` (QueueEvents runs blocking commands like the worker)
3. **`releaseForRetry` was missing**: Luna added it to close the gap between `fail` (permanent) and BullMQ retry (recoverable)

## Drill results

| Drill | Result |
|---|---|
| Browser-independent start | ✔ Enqueue → claim → session/turn checkpoint → stream → `run.completed` with real model output |
| Terminal error durability | ✔ `429 no credits` → `status: failed`, `errorCode: trueforge_terminal` durably recorded |
| Writer runs (2x) | ✔ Both completed with real model output, events persisted to Convex |
| SIGTERM graceful shutdown | ✔ `shutdown_started` → `shutdown_complete`, zero active subscriptions at kill |
| Kill-recovery mid-stream | Blocked (runs finish too fast for manual kill timing — needs longer prompt) |
| Pause/resume | Blocked (needs agent config that triggers approval pause) |

## NPM scripts added

| Script | Command |
|---|---|
| `dev:worker` | `tsx watch --env-file=.env.local worker/agent-runs.ts` |
| `worker` | `tsx --env-file=.env.local worker/agent-runs.ts` |
| `enqueue:run` | `tsx --env-file=.env.local worker/enqueue-agent-run.ts` |

## Dependencies added

- `bullmq` ^5.81.3
- `ioredis` ^5.11.1
- `convex` ^1.45.0

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `REDIS_URL` | Yes | Upstash TCP `rediss://` or local `redis://127.0.0.1:6390` |
| `CONVEX_URL` | Yes | Convex cloud URL (`https://<deployment>.convex.cloud`) |
| `NEXT_PUBLIC_CONVEX_URL` | Yes | Same as `CONVEX_URL` (used by frontend Convex provider) |
| `TRUEFORGE_BASE_URL` | No | Defaults to `http://localhost:8790` |
| `WORKER_ID` | No | Custom worker identity (default: `agent-runs-<pid>`) |
| `WORKER_CONCURRENCY` | No | Max concurrent jobs (default: 2) |
