# TrueForge detach and recovery probe

This isolated probe tests the provider behavior required by the restartable worker. It does not mutate product records or queue jobs.

The probe uses the recovery-safe sequence documented in [the SDK research](../trueforge-sdk-recovery-research.md):

1. Create a session and write its `sessionId` to a local state file.
2. Start the turn with non-streaming `sessions.createTurn` and write its `turnId` **before** opening an SSE stream.
3. Subscribe with `sessions.subscribeToTurn`, checkpoint each SSE ID and its numeric provider sequence when available, then deliberately abort the subscriber.
4. In a distinct process, subscribe again using `afterSequenceNumber` (the exclusive persisted cursor).
5. Reconcile with `getTurn` and `listTurnEvents` if the second subscriber cannot observe a terminal event.

## Prerequisites

- Node 22 or newer.
- A running TrueForge server reachable by `TRUEFORGE_BASE_URL` (defaults to `http://localhost:8790`).
- The name of a configured TrueForge agent. The probe does not create or modify agent configuration.

The command accepts the prompt as a CLI argument but deliberately does **not** copy it into evidence output. Use a harmless prompt that takes long enough to detach after `turn.created`; a simple answer may finish before the detach checkpoint.

## Runbook

Choose an ignored/local state path outside committed source, then start and detach:

```bash
export TRUEFORGE_BASE_URL=http://localhost:8790
STATE="${TMPDIR:-/tmp}/trueforge-recovery-$(date +%s).json"

npx tsx scripts/spikes/trueforge-recovery.ts start \
  --state "$STATE" \
  --agent researcher \
  --message "Work through several deliberate steps before replying with a short answer: explain why a worker should persist a stream cursor." \
  --detach-after-events 1
```

The default `--detach-after-events 1` checkpoints the first event, normally `turn.created`, and then aborts the first subscriber. This intentionally simulates a worker process disappearing without cancelling the server-side turn. The printed JSON contains the persisted session, turn, and provider-cursor metadata; the full state file is the evidence artifact.

Run the second command from a separate shell/process:

```bash
npx tsx scripts/spikes/trueforge-recovery.ts resume --state "$STATE" --max-wait-ms 120000
```

If the server-side turn lasts beyond the timeout, or if a network error occurs, inspect its durable provider state without subscribing again:

```bash
npx tsx scripts/spikes/trueforge-recovery.ts reconcile --state "$STATE"
cat "$STATE"
```

### Retention / TTL check

Keep the same state file and run this non-mutating command hours or days later:

```bash
npx tsx scripts/spikes/trueforge-recovery.ts inspect --state "$STATE"
```

`inspect` checks the session itself, its selected turn, and its persisted event inventory. It records `retained_state_present` or `retained_state_missing_or_unavailable` in the most recent attempt; it does not infer a provider TTL from a same-day result.

Do not reuse a state file with `start`; the script refuses to overwrite an existing one. This prevents a mistaken new run from being confused with recovery evidence.

## Additional live probes

### Concurrent turn while the detached turn is active

This is an explicit mutation: it attempts one cheap second turn with `previousTurnId: "auto"` while the saved turn is still `running`. The script first records a structured block unless confirmation is present.

```bash
npx tsx scripts/spikes/trueforge-recovery.ts concurrent \
  --state "$STATE" \
  --confirm-concurrent
```

Evidence in `concurrentTurn` distinguishes `rejected_precondition_failed_412`, another rejection, and `second_turn_accepted`. In the accepted case it reads both turn states immediately and records `autoEffect` as either `active_turn_cancelled_after_auto` or `no_immediate_active_turn_cancellation_observed`. A terminal original turn is recorded as `blocked_original_not_running`, not treated as concurrent-turn evidence.

### Stale approval or response selector

A selector is only stale if its source turn is retained and is not the newest turn in the session. The probe automatically uses a captured `tool.approval_required` or `tool.response_required` event when one exists. Otherwise supply the selector from a known paused turn:

```bash
npx tsx scripts/spikes/trueforge-recovery.ts stale-selector \
  --state "$STATE" \
  --thread-id <thread-id> \
  --tool-call-id <tool-call-id> \
  --source-turn-id <earlier-turn-id> \
  --kind approval \
  --confirm-stale-selector
```

Approval probes always send **deny**, never allow. Response probes send the harmless `--content` value (or a fixed probe string). The state records the provider result as `provider_accepted_stale_selector` or `provider_rejected_stale_selector`, including an HTTP status when the SDK exposes one. It records `blocked_no_pause_fixture`, `blocked_selector_not_yet_stale`, or `blocked_source_turn_not_retained` when live setup cannot establish the required earlier-turn fixture. The command does not fabricate a pause because the ability to create one is agent/tool configuration specific.

## Evidence schema and interpretation

The state file is JSON and contains:

| Field | Meaning |
| --- | --- |
| `sessionId`, `turnId` | IDs persisted before long-lived consumption begins. |
| `providerCursor` | Last SSE `id` plus `sequenceNumber` when the ID is a safe integer. The resume command passes that number as `afterSequenceNumber`. |
| `events` | Compact per-delivery metadata: phase, SSE ID, numeric sequence, provider event ID/type, terminal status, and whether the SSE ID was already observed. No model content is retained. |
| `attempts` | Start/resume/reconcile connection attempts, the resume cursor used, and any error. |
| `terminal` | A compact terminal state captured from the stream or `getTurn`. |
| `reconciliation` | `getTurn` state plus a persisted-event count and type histogram from `listTurnEvents`. |
| `inspection` | A later retained-state check for the session, selected turn, and persisted events. |
| `concurrentTurn` | Concurrent `previousTurnId: "auto"` result, including 412/rejection details or immediate original-turn effect. |
| `staleSelector` | Stale selector result, or a structured fixture/retention/confirmation block. |
| `verdict` | A machine-readable recovery conclusion listed below. |

Interpret `verdict` as follows:

- `recovered_to_terminal` — the second invocation consumed a `turn.done` event after the first subscriber detached. This is the desired recovery result.
- `terminal_reconciled_without_sse` — `getTurn` confirmed a terminal provider state even though the recovery stream did not provide terminal evidence. This proves terminal reconciliation, but not live SSE replay.
- `unable_to_resume` — the resumed subscription failed and `getTurn` still reports a running turn. Preserve the state file and error for investigation; do not start a second turn automatically.
- `still_running` — no terminal state was available by the timeout. Re-run `resume` or `reconcile` later with the same state file.
- `terminal_before_detach` — the turn completed before the intended detach point, so the run does not test recovery. Use a longer-running harmless prompt and a new state file.
- `detached_ready_for_resume` — the first process detached successfully and is ready for the separate `resume` invocation.
- `start_failed` — the state file was written but session or non-streaming turn creation failed. The first `attempts` entry contains the provider/connection error, so an unavailable local server is explicit evidence rather than an assumed result.

The resume request only supplies `afterSequenceNumber` when the persisted SSE ID is numeric. If the server emits a non-numeric SSE ID, the state still records it, but the SDK endpoint cannot safely receive it as `after_sequence_number`; the recovery attempt intentionally subscribes without that query cursor and the evidence makes the limitation visible.

## Scope and limitations

- The intentional detach disables the SDK's automatic reconnect for that one subscription. That makes a process-loss simulation deterministic; it does not test the SDK's in-process reconnect behavior.
- The probe does not cancel the turn. If a run must be stopped, use the provider's session cancellation path separately and record it as a cancellation test, not as successful subscriber recovery.
- `listTurnEvents` excludes streaming deltas by provider contract, so it is used only for durable terminal reconciliation and event inventory. SSE evidence remains the source for cursor/replay behavior.
- The concurrent and stale-selector commands intentionally create provider turns only after explicit confirmation. They are evidence probes, not normal recovery operations.
- This is evidence for the provider contract, not a replacement for worker idempotency, queue locking, or application-level event deduplication.
