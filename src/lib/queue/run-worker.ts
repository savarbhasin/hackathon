import { TrueForge, isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import { trueForgeBaseUrl } from "./env";
import { workerLog } from "./log";
import type { AgentRunRecord, AgentRunStore, PendingAction } from "./types";
import { RecoverableRunError } from "./types";
import { processDurableOrchestratorRun } from "../durable-orchestrator";
import { processDurableSpecialistRun } from "../durable-specialist";

type WorkerContext = { workerId: string; signal: AbortSignal };
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : null;
}

function launchInput(input: unknown): { agentName: string; items: UnknownRecord[] } {
  const value = asRecord(input);
  const agentName = typeof value?.agentName === "string" ? value.agentName : undefined;
  const items = Array.isArray(value?.items) ? value.items : Array.isArray(value?.input) ? value.input : undefined;
  if (!agentName || !items || !items.every((item) => asRecord(item))) {
    throw new Error("Invalid durable run input: expected { agentName, items: TurnInputItem[] }");
  }
  return { agentName, items: items as UnknownRecord[] };
}

function resumeItems(value: unknown): UnknownRecord[] {
  const items = Array.isArray(value) ? value : asRecord(value)?.items;
  if (!Array.isArray(items) || !items.every((item) => asRecord(item))) {
    throw new Error("Invalid pending resume input: expected TurnInputItem[]");
  }
  return items as UnknownRecord[];
}

function numberCursor(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function eventPayload(event: unknown): UnknownRecord {
  // Preserve provider-facing event structure in Convex without putting it in logs.
  return (asRecord(event) ?? { type: "unknown" }) as UnknownRecord;
}

function pendingActions(state: UnknownRecord): PendingAction[] {
  const source = Array.isArray(state.requiredActions) ? state.requiredActions : [];
  return source.flatMap((value) => {
    const action = asRecord(value);
    if (!action) return [];
    const type = action.type;
    if (type !== "tool.approval_required" && type !== "tool.response_required" && type !== "mcp.auth_required") return [];
    const toolCalls = Array.isArray(action.toolCalls)
      ? action.toolCalls.flatMap((call) => {
        const item = asRecord(call);
        return typeof item?.id === "string"
          ? [{ id: item.id, ...(typeof item.sourceEventId === "string" ? { sourceEventId: item.sourceEventId } : {}) }]
          : [];
      })
      : [];
    return [{ type, threadId: typeof action.threadId === "string" ? action.threadId : null, toolCalls }];
  });
}

function terminalErrorIsRecoverable(message: string): boolean {
  const normalized = message.toLowerCase();
  if (normalized.includes("no credits") || normalized.includes("unauthorized") || normalized.includes("forbidden") || normalized.includes("invalid")) return false;
  return /\b(408|429|5\d\d)\b/.test(normalized) || normalized.includes("timeout") || normalized.includes("temporar") || normalized.includes("unavailable");
}

function streamError(error: unknown): RecoverableRunError {
  const value = error as { message?: unknown; code?: unknown };
  const message = typeof value?.message === "string" ? value.message : "TrueForge stream disconnected";
  const code = typeof value?.code === "string" ? value.code : "trueforge_stream";
  return new RecoverableRunError(code, message);
}

function recoverableInfrastructureError(error: unknown): RecoverableRunError | null {
  if (error instanceof RecoverableRunError) return error;
  const value = error as { message?: unknown; code?: unknown; name?: unknown; statusCode?: unknown };
  const message = typeof value?.message === "string" ? value.message : "";
  const code = typeof value?.code === "string" ? value.code : "infrastructure";
  const status = typeof value?.statusCode === "number" ? value.statusCode : 0;
  const normalized = message.toLowerCase();
  if (normalized.includes("no credits") || normalized.includes("unauthorized") || normalized.includes("forbidden")) return null;
  if (value?.name === "AbortError" || /fetch failed|econn|enotfound|network|timeout|temporar|unavailable/.test(normalized) || status === 408 || status === 429 || status >= 500) {
    return new RecoverableRunError(code, message || "Recoverable infrastructure failure");
  }
  return null;
}

async function requireCheckpoint(ok: boolean, description: string): Promise<boolean> {
  if (ok) return true;
  workerLog("run.ownership_lost", { description });
  return false;
}

/**
 * Owns one BullMQ job until TrueForge reaches a terminal state or a durable
 * human pause. All provider IDs/cursors are committed before this promise can
 * resolve, so BullMQ never acknowledges uncheckpointed stream progress.
 */
export async function processAgentRun(store: AgentRunStore, runId: string, context: WorkerContext): Promise<void> {
  let claimed: AgentRunRecord | null;
  try {
    const snapshot = await store.get(runId);
    if (!snapshot || ["completed", "failed", "cancelled", "waiting_for_user", "waiting_for_approval"].includes(snapshot.status)) {
      workerLog("run.claim_noop", { runId, workerId: context.workerId, status: snapshot?.status ?? null });
      return;
    }
    // A retried stalled job supplies the latest attempt as an optimistic guard.
    // BullMQ still owns the live-job lease; Convex prevents stale owners winning.
    claimed = await store.claim({ runId, workerId: context.workerId, expectedAttempt: snapshot.attempt });
  } catch (error) {
    throw streamError(error);
  }
  if (!claimed) {
    workerLog("run.claim_noop", { runId, workerId: context.workerId, status: "claim_rejected" });
    return;
  }

  const run = claimed;
  const attempt = run.attempt;
  if (run.kind === "orchestrator") {
    await processDurableOrchestratorRun(store, run, context);
    return;
  }
  if (run.kind === "specialist") {
    await processDurableSpecialistRun(store, run, context);
    return;
  }
  if (run.kind === "schedule") {
    // Scheduled runs use the same durable orchestrator spec/session behavior,
    // but intentionally have no conversation projection.
    await processDurableOrchestratorRun(store, run, context);
    return;
  }
  const tf = new TrueForge({ baseUrl: trueForgeBaseUrl(), timeoutInSeconds: 60, maxRetries: 0 });
  let turnId = run.turnId;

  try {
    let sessionId = run.sessionId;
    const hasResume = run.resumeInput !== undefined && run.resumeInput !== null;

    if (!sessionId) {
      const start = launchInput(run.input);
      const { data: session } = await tf.sessions.create({ agent: { name: start.agentName } });
      sessionId = session.id;
      if (!await requireCheckpoint(await store.checkpointSession({ runId, attempt, workerId: context.workerId, sessionId }), "checkpoint_session")) return;
    }

    if (hasResume) {
      if (!run.turnId || !run.pendingActions) throw new Error("Resume run is missing its paused turn or pending actions");
      const knownTurns = await tf.sessions.listTurns(sessionId, { limit: 25 });
      const newestTurn = knownTurns.data[0];
      const retainedTurnIds: string[] = [];
      for await (const knownTurn of knownTurns) retainedTurnIds.push(knownTurn.id);
      const pausedTurnIndex = retainedTurnIds.indexOf(run.turnId);
      // listTurns is newest-first. Only a newer tip can be an uncheckpointed
      // resume; older conversation history is not a recovery candidate.
      const uncheckpointedResume = pausedTurnIndex > 0 ? newestTurn : undefined;
      if (uncheckpointedResume) {
        turnId = uncheckpointedResume.id;
        workerLog("run.reconciled_uncheckpointed_resume", { runId, attempt, turnId });
      } else {
        const { data: turn } = await tf.sessions.createTurn(sessionId, { input: resumeItems(run.resumeInput) as never });
        turnId = turn.id;
      }
      if (!await requireCheckpoint(await store.checkpointSessionTurn({
        runId, attempt, workerId: context.workerId, sessionId, turnId, expectedTurnId: run.turnId,
      }), "checkpoint_resume_turn")) return;
      if (!await requireCheckpoint(await store.acceptResume({
        runId, attempt, workerId: context.workerId, turnId, pendingAction: run.pendingActions,
      }), "accept_resume")) return;
    } else if (!turnId) {
      // If a process died after TrueForge accepted createTurn but before the
      // turn ID checkpoint, recover the newest provider turn on this persisted
      // session instead of issuing a potentially duplicate external action.
      const knownTurns = await tf.sessions.listTurns(sessionId, { limit: 25 });
      const recoveredTurn = knownTurns.data[0];
      if (recoveredTurn) {
        turnId = recoveredTurn.id;
        workerLog("run.reconciled_uncheckpointed_turn", { runId, attempt, turnId });
      } else {
        const start = launchInput(run.input);
        const { data: turn } = await tf.sessions.createTurn(sessionId, { input: start.items as never, previousTurnId: "none" as never });
        turnId = turn.id;
      }
      if (!await requireCheckpoint(await store.checkpointSessionTurn({ runId, attempt, workerId: context.workerId, sessionId, turnId }), "checkpoint_new_turn")) return;
    }

    const cursor = hasResume ? undefined : run.providerSequence;
    const stream = await tf.sessions.subscribeToTurn(
      sessionId,
      turnId,
      cursor === undefined ? {} : { afterSequenceNumber: cursor },
      { abortSignal: context.signal }
    );
    const mergedMessages = new Map<string, UnknownRecord>();
    let fallbackSequence = (cursor ?? 0) + 1;

    for await (const metadata of stream.withMetadata()) {
      if (context.signal.aborted) throw new RecoverableRunError("worker_shutdown", "Worker shutdown interrupted provider subscription");
      const event = eventPayload(metadata.data);
      const type = typeof event.type === "string" ? event.type : "unknown";
      const providerSequence = numberCursor(metadata.id);
      const sequence = providerSequence ?? fallbackSequence++;
      const providerEventId = typeof event.id === "string" && !isEventDelta(metadata.data as never) ? event.id : undefined;

      if (type === "model.message") {
        const id = typeof event.id === "string" ? event.id : undefined;
        if (id) mergedMessages.set(id, event);
      } else if (isEventDelta(metadata.data as never)) {
        const id = typeof event.id === "string" ? event.id : undefined;
        if (id) {
          const base = mergedMessages.get(id);
          if (base) mergeEventDelta(base as never, metadata.data as never);
        }
      }

      // Event insertion precedes cursor advancement: a crash cannot skip data.
      await store.appendProviderEvent({
        runId, attempt, workerId: context.workerId, turnId, sequence, providerEventId, providerSequence: providerSequence ?? undefined, type, payload: event,
      });
      if (providerSequence !== null && !await requireCheckpoint(await store.checkpointProviderCursor({
        runId, attempt, workerId: context.workerId, turnId, providerSequence,
      }), "checkpoint_cursor")) return;

      if (type !== "turn.done") continue;
      const state = asRecord(event.state) ?? { status: "error", message: "turn.done had no state" };
      const status = state.status;
      if (status === "done") {
        const actions = pendingActions(state);
        if (actions.length > 0) {
          const pause = actions.some((action) => action.type === "tool.approval_required")
            ? store.waitForApproval({ runId, attempt, workerId: context.workerId, pendingActions: actions })
            : store.waitForUser({ runId, attempt, workerId: context.workerId, pendingActions: actions });
          if (!await requireCheckpoint(await pause, "persist_pause")) return;
          workerLog("run.paused", { runId, attempt, turnId, actionCount: actions.length });
          return;
        }
        const output = asRecord(state.output);
        if (!await requireCheckpoint(await store.complete({ runId, attempt, workerId: context.workerId, turnId, output }), "complete")) return;
        workerLog("run.completed", { runId, attempt, turnId });
        return;
      }
      if (status === "cancelled") {
        if (!await requireCheckpoint(await store.cancel({ runId, attempt, workerId: context.workerId, turnId }), "cancel")) return;
        workerLog("run.cancelled", { runId, attempt, turnId });
        return;
      }
      const message = typeof state.message === "string" ? state.message : "TrueForge turn returned an error state";
      if (terminalErrorIsRecoverable(message)) throw new RecoverableRunError("trueforge_terminal_transient", message);
      await store.fail({ runId, attempt, workerId: context.workerId, turnId, errorCode: "trueforge_terminal", errorMessage: message });
      workerLog("run.failed", { runId, attempt, turnId, code: "trueforge_terminal" });
      return;
    }

    throw new RecoverableRunError("trueforge_stream_ended", "Provider stream ended without turn.done");
  } catch (error) {
    const recoverable = recoverableInfrastructureError(error);
    if (recoverable) {
      // releaseForRetry preserves session/turn/cursor, allowing the retry to attach.
      await store.releaseForRetry({ runId, attempt, workerId: context.workerId, errorCode: recoverable.code, errorMessage: recoverable.message });
      throw recoverable;
    }
    const message = error instanceof Error ? error.message : "Unknown worker failure";
    await store.fail({ runId, attempt, workerId: context.workerId, turnId, errorCode: "worker_permanent", errorMessage: message });
    workerLog("run.failed", { runId, attempt, turnId: turnId ?? null, code: "worker_permanent" });
  }
}
