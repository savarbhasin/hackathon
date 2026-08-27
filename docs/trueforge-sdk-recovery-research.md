# TrueForge SDK Recovery & Resume Research

Research into `@truefoundry/trueforge-sdk@0.1.3` and its worker usage in `src/lib/durable-orchestrator.ts`, `src/lib/durable-specialist.ts`, and `src/lib/queue/run-worker.ts`. SDK evidence comes from the installed package's declarations, implementations, `reference.md`, and `README.md`, read on Aug 26 2026.

## Verdict table

| # | Question | Verdict |
|---|----------|---------|
| 1 | Turn resumption (re-subscribe by sessionId+turnId) | **ANSWERED** — `subscribeToTurn` with `after_sequence_number` exists |
| 2 | Event cursors/dedup fields; delta merging | **ANSWERED** (mechanism); cursor↔sequence-number wire format **PARTIALLY** |
| 3 | Session lifecycle / TTL | **PARTIALLY** — sessions are server-persisted, creator-scoped; no documented TTL |
| 4 | Cancellation API + terminal events | **ANSWERED** — `sessions.cancel` → `turn.done` with `status: "cancelled"` |
| 5 | Pause/resume input shapes | **ANSWERED** — `user.tool_approval` / `user.tool_response` items in a new turn |
| 6 | Terminal states & error taxonomy | **ANSWERED** for statuses (`done`/`cancelled`/`error`); recoverable-vs-permanent classification **PARTIALLY** |
| 7 | SSE auto-reconnect | **ANSWERED** — subscribe streams auto-reconnect; createTurnStream does NOT |
| 8 | Second concurrent turn on same session | **PARTIALLY** — 412 PreconditionFailedError is declared; exact body unverified |

---

## 1. Turn resumption: re-subscribing to an existing turn

**Yes — a dedicated resumable subscribe endpoint exists, with an exclusive sequence-number cursor.**

Signature (`dist/cjs/api/resources/sessions/client/Client.d.ts:234-237`):

```ts
/**
 * Subscribe to the live SSE stream for a turn. Only the session creator (`created_by`)
 * may subscribe. Pass `after_sequence_number` to resume after a disconnect
 * (exclusive — events after this sequence number are replayed).
 */
subscribeToTurn(session_id: string, turn_id: string,
  request?: TrueForge.SubscribeToTurnSessionsRequest,
  requestOptions?: SessionsClient.RequestOptions):
    core.HttpResponsePromise<core.Stream<TrueForge.TurnStreamingEvent>>;
```

Request shape (`.../sessions/client/requests/SubscribeToTurnSessionsRequest.d.ts`):

```ts
export interface SubscribeToTurnSessionsRequest {
    /** Exclusive resume cursor: replay only events with a sequence number greater than
     *  this value. Omit to start from the beginning of the live buffer. */
    afterSequenceNumber?: number | null;
}
```

Wire details from the implementation (`.../sessions/client/Client.js:1328-1343`): it issues
`GET api/v1/sessions/{session_id}/turns/{turn_id}/subscribe?after_sequence_number=…`
with `responseType: "sse"`, and marks the stream `resumable: true` (line 1392).

Key facts:

- Resumption is per turn, keyed by `(sessionId, turnId)`. Mission Control checkpoints both IDs and the provider sequence on each Convex `AgentRun`.
- Cursor is **exclusive replay**: events with sequence number > `after_sequence_number` are replayed. Omitting the cursor starts "from the beginning of the live buffer" — i.e. subscribing with no cursor to a finished turn should replay buffered events rather than hang, but "live buffer" retention size/lifetime is **not documented anywhere in the package** (see §Needs-live-verification).
- There is also a non-streaming fallback for recovery: `listTurnEvents(session_id, turn_id)` ("Paginated persisted events for a turn", Client.d.ts:216-233) returns persisted events (deltas excluded) and `getTurn(session_id, turn_id)` returns the turn's terminal `state`. So even if the live buffer is gone, a new process can reconstruct final state via `getTurn` + `listTurnEvents`.
- `listEvents(session_id)` (Client.d.ts:116-132) lists events across the active turn branch "including persisted events from a running tip".

What happens when subscribing to an *abandoned* turn: not directly documented. The existence of `TurnStateCancelledReason.Abandoned = "abandoned"` (`api/types/TurnStateCancelledReason.d.ts`) strongly suggests the server itself cancels abandoned turns, which would then surface as a normal `turn.done {status:"cancelled", reason:"abandoned"}` on the subscribed stream. Needs live verification.

## 2. Event cursors, dedup fields, delta merging

- Every event carries a monotonic ULID `id` field. The worker persists provider event IDs and sequences through `appendProviderEvent` before moving its cursor.
- The SSE transport layer has its own per-connection event id used as the resume cursor: `stream.withMetadata()` yields `{ data, id }` (`core/stream/Stream.d.ts:44-49`, `ServerSentEvent.id?: string`). The worker parses that ID as `providerSequence` and checkpoints it. The subscribe endpoint's reconnect path sends it back as an HTTP `Last-Event-ID` header (Client.js:1355), and the query-param equivalent is `after_sequence_number`. No SDK type explicitly names that mapping, so this remains partially confirmed.
- Deltas confirmed: base `model.message` events arrive empty and content arrives via `model.message.delta` fragments sharing the same `id`:
  - `ModelMessageEvent.content?` is optional/null; `ModelMessageDeltaEvent` carries incremental `content`, `reasoningContent`, `toolCalls` chunks (`api/types/ModelMessageEvent.d.ts`, `ModelMessageDeltaEvent.d.ts`).
  - `isEventDelta(event)` = `event.type === "model.message.delta"` (`events.js`, exported from package root; decl at `events.d.ts:6-8`).
  - `mergeEventDelta(base, delta)` merges in place: appends content/reasoning text, merges tool-call fragments by `index` (arguments concatenated; only sequential indexes appended), overwrites `finishReason`/`usage`/`refusal`; **no-ops when ids mismatch or base isn't `model.message`** (`events.js` implementation; contract at `events.d.ts:9-18`). This matches AGENTS.md gotcha #2.
- Note: persisted-event listings exclude deltas ("streaming deltas are not included", reference.md:1163-1177), so a recovered process replaying persisted events gets complete base events instead.

## 3. Session lifecycle

- Sessions are first-class server-side records: `Session { id, agent, createdBy, title, createdAt, updatedAt }` (`api/types/Session.d.ts`). Creation is independent of turns — `create({ agent })` takes only an agent binding (`CreateSessionRequest.d.ts`), and the docstring says named sessions "snapshot the agent name at create and resolve the live agent on each turn" (Client.d.ts:28). Nothing requires a session to be created by the same process that runs turns.
- Access is scoped to the creator identity: get/delete/update/cancel/subscribe all say only the session creator may act. Convex persists session ownership on the `AgentRun`, so another worker process can resume the same provider turn.
- `delete` is idempotent ("Idempotent if already gone", Client.d.ts:65).
- **No documented expiry/TTL anywhere** in `reference.md`, `README.md`, or the types. Only indirect hints: cancellation reason `"abandoned"` and `"server-execution-timeout"` exist for *turns* (`TurnStateCancelledReason.d.ts`). Whether the TrueForge store garbage-collects idle sessions is unknown → needs live verification.
- Sessions can be listed (`sessions.list`, token-paginated, filterable by `agentId`/timestamps) — useful for reconciliation of orphaned sessions after crashes.

## 4. Cancellation

```ts
/** Cancel the running last turn for a session. Only the session creator may cancel. */
cancel(session_id: string, request?: TrueForge.CancelSessionRequest,
  requestOptions?): core.HttpResponsePromise<TrueForge.CancelSessionResponse>;
```
(Client.d.ts:99-114.)

- Body is empty (`CancelSessionRequest = {}`); response is `{}` — "HTTP 200 means the cancel request was accepted (or nothing was running)" (`CancelSessionResponse.d.ts`). So cancel is effectively fire-and-forget/idempotent-ish.
- Throws `PreconditionFailedError` among others (Client.d.ts:107) — presumably when there is nothing running, though the exact condition is undocumented.
- Terminal emission: cancellation surfaces as `turn.done` with `state.status: "cancelled"` (`TurnDoneEventState = TurnStateCancelled | TurnStateDone | TurnStateError`, `TurnDoneEvent.d.ts:6-7`), carrying `reason: "client-cancelled" | "server-execution-timeout" | "cancelled-for-next-turn" | "abandoned"` (`TurnStateCancelledReason.d.ts`). The worker records this terminal state through its guarded run transition.
- Cancel targets "the running **last** turn" — you cannot cancel an arbitrary historical turn by id.

## 5. Pause/resume input shapes

Pause signals arrive as stream events `tool.approval_required` / `tool.response_required` / `mcp.auth_required` (`ActionRequiredEvent` union, `api/types/ActionRequiredEvent.d.ts`), each carrying `threadId` and `toolCalls: ToolCallRef[]`. A paused turn ends streaming with `turn.done` whose `state.status === "done"` but `requiredActions` is non-empty. The worker normalizes those actions before the Convex waiting-state transition.

Resume is a **NEW turn on the same session** whose input contains only resume items. From `api/types/TurnInputItem.d.ts`:

```ts
export type TurnInputItem =
  | TrueForge.UserMessage              // { type: "user.message", content }
  | TrueForge.UserToolApprovalEvent
  | TrueForge.UserToolResponseEvent;
```

Exact shapes:

```ts
// UserToolApprovalEvent.d.ts
{ type: "user.tool_approval", threadId: string, toolCallId: string,
  approval: ApprovalDecision }   // { status: "allow" } | { status: "deny", reason?: string }

// UserToolResponseEvent.d.ts
{ type: "user.tool_response", threadId: string, toolCallId: string, content: string }
```

The request docstring warns: "**Do not mix user messages with approval or tool-response items**" (`CreateTurnSessionsRequest.d.ts`). `orchestrator-pause.ts` builds resume-only inputs, and the worker sends them in a new turn.

Acceptance confirmation: the resumed turn streams normally. `previous_turn_id` defaults to `"auto"`, so the resumed turn inherits context. Acceptance is observable as a fresh `turn.created` and continued execution; there is no dedicated acknowledgement event. The worker clears pending actions only after checkpointing the new turn.

## 6. Terminal states & error taxonomy

Full turn state machine (`api/types/TurnState*.d.ts`):

| Status | Type | Fields |
|---|---|---|
| `running` | `TurnStateRunning` | (none beyond status) |
| `done` | `TurnStateDone` | `completedAt`, `metrics?`, `output: ModelMessageEvent \| null`, `requiredActions: ActionRequiredEvent[]` |
| `cancelled` | `TurnStateCancelled` | `completedAt`, `reason` (`client-cancelled` / `server-execution-timeout` / `cancelled-for-next-turn` / `abandoned`), `metrics?` |
| `error` | `TurnStateError` | `completedAt`, `message: string`, `metrics?` |

Lifecycle events on the stream: `turn.created` → content events (`model.message[.delta]`, `tool.call`-family, `sandbox.created`, `thread.created/done`, `mcp.initialize`) → `turn.done` (`reference.md:1163-1177`). `turn.done` is the single terminal event for all three end states; distinguish them via `state.status`.

Recoverable vs permanent:

- **Transport/stream errors** (fetch failure, non-2xx on connect, exhausted retries) throw before any terminal event — these are recoverable: re-subscribe via §1. `error.status === "error"` turns carry only a free-form human `message` with **no machine-readable error code or class**, so permanent-vs-transient must be inferred heuristically (message text, or retry policy).
- `cancelled` reasons give some taxonomy: `server-execution-timeout` and `abandoned` are infrastructure failures; `client-cancelled` is intentional.
- Recoverable worker failures release the guarded claim while preserving the provider checkpoint, so BullMQ retries can reattach.
- HTTP-level retryability: the SDK retries 408/429/5xx on regular requests (README.md:551-563), and `maxRetries` is honored on both the initial subscribe request and its reconnects.

## 7. Reconnect behavior on stream drop

**Asymmetric — this is the sharpest finding in the package:**

- `subscribeToTurn` streams are **resumable**: `eventShape: { type: "sse", resumable: true }` plus a `reconnect(lastEventId)` closure that re-issues the GET with header `Last-Event-ID` (Client.js:1390-1396, 1350-1375). The `core.Stream` then transparently reconnects mid-stream:
  - `reconnectionEnabled` defaults to true (`Stream.d.ts:16-19`);
  - up to `maxReconnectionAttempts` **consecutive** failures before giving up, default **5**, counter resets on any progress (`Stream.d.ts:20-26`, `Stream.js:45`);
  - delay = server-sent `retry:` directive clamped to ≤30s, else default 1000ms, abort-aware (`Stream.d.ts:82-89`, `Stream.js:46-47, 364-370`).
- `createTurnStream` is not resumable. The worker avoids it: it creates a non-streaming turn, checkpoints the turn ID, and consumes events through `subscribeToTurn`.

## 8. Starting a second turn while one is active

Not explicitly documented as prose. Evidence:

- `createTurn` / `createTurnStream` declare `@throws PreconditionFailedError` (HTTP 412 handling at Client.js:861-868) — the only plausible guard for "a turn is already running", alongside 400/403/404/413/422.
- `cancel` also declares 412 (Client.d.ts:107).
- `previous_turn_id` semantics ("chain to the session's last turn") imply a linear branch model; `cancelled-for-next-turn` as a cancel reason suggests creating a new turn may cancel a running tip in some flow.
- Non-streaming creation (`stream: false`) is explicitly designed around a running background turn: "return the turn immediately with `state.status: \"running\"` while execution continues in the background; use get turn or subscribe to observe completion" (Client.d.ts:154). That is the sanctioned pattern for crash-safe dispatch: start the turn, persist ids, attach later.

Conclusion: concurrent-turn behavior is guarded server-side (412 family) but the exact response body and whether `auto` chaining races are possible must be verified live.

---

## Implications for the BullMQ worker design

**Overall verdict: GO.** The SDK/server API was clearly designed for detached subscribers: `subscribeToTurn(after_sequence_number)`, non-streaming turn creation with background execution, persisted turn events via `listTurnEvents`, idempotent delete, and server-side abandoned-turn cancellation.

Concrete recommendations:

1. **Persist before start.** Admit the run in Convex, checkpoint the TrueForge session, then create the turn and checkpoint its id before subscribing. The worker can then recover from either checkpoint without an open browser.

2. **Consume via `subscribeToTurn`, never via the create-stream socket.** The worker ensures `sessionId` and `turnId` are checkpointed, subscribes after `providerSequence`, and processes through `turn.done`. Convex stores the cursor and deduplicates provider event ids.

3. **Keep the delta machinery identical.** Replayed streams include deltas too. The worker uses `isEventDelta` and `mergeEventDelta`, keyed by event id. For deep reconstruction use `getTurn` plus `listTurnEvents`.

4. **Stale-job safety.** BullMQ may redeliver. Convex claims each run by worker and attempt, while event ids and operation keys make repeated writes harmless.

5. **Cancellation.** Use `sessions.cancel(sessionId)` for user-initiated aborts. The worker records `turn.done {status:"cancelled", reason}` and finalizes the Convex task projection.

6. **Pause/resume stays a new turn.** Resume uses the same session with only `user.tool_approval` or `user.tool_response` items. Convex stores the selector, thread id, and tool call id before BullMQ receives the resume job.

### Claims still needing live verification against :8790

1. Subscribing (no cursor) to a **finished** turn replays the full buffer vs errors vs hangs; buffer retention window/size.
2. Subscribing to an **abandoned/timed-out** turn yields `turn.done {status:"cancelled", reason:"abandoned"|"server-execution-timeout"}` on the stream (vs immediate error).
3. SSE `id:` values equal the integer sequence numbers accepted by `after_sequence_number` (the Last-Event-ID round-trip strongly implies it).
4. Whether `after_sequence_number` replay includes deltas, and whether replayed `model.message` bases arrive populated (persisted listings suggest yes).
5. Exact 412 behavior/body when creating a turn while another is running; whether `previous_turn_id: "auto"` ever triggers `cancelled-for-next-turn` implicitly.
6. Session GC/TTL: do sessions (and their event history) survive indefinitely, and does `sessions.list` see sessions created days earlier?
7. Whether `stream:false` + `getTurn` polling shows live `state` transitions (running→terminal) reliably enough to use as a watchdog alongside subscribe.
8. Behavior when the resume `user.tool_approval` references a toolCallId from a turn several turns back (stale pendingActions after worker restart).
