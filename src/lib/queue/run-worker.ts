import { workerLog } from "./log";
import type { AgentRunStore } from "./types";
import { RecoverableRunError } from "./types";
import { processDurableOrchestratorRun } from "../durable-orchestrator";
import { processDurableSpecialistRun } from "../durable-specialist";

type WorkerContext = { workerId: string; signal: AbortSignal };

function streamError(error: unknown): RecoverableRunError {
  const value = error as { message?: unknown; code?: unknown };
  const message = typeof value?.message === "string" ? value.message : "TrueForge stream disconnected";
  const code = typeof value?.code === "string" ? value.code : "trueforge_stream";
  return new RecoverableRunError(code, message);
}

/**
 * Owns one BullMQ job until TrueForge reaches a terminal state or a durable
 * human pause. Terminal provider cursors are committed with the lifecycle
 * transition before this promise can resolve; in-progress events are replayed
 * from TrueForge after a retry.
 */
export async function processAgentRun(store: AgentRunStore, runId: string, context: WorkerContext): Promise<void> {
  let claimed: Awaited<ReturnType<AgentRunStore["get"]>>;
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
  // AgentRunKind is intentionally closed: all admitted runs use one of the
  // durable handlers above. Keep this guard for malformed legacy records.
  throw new Error(`Unsupported durable run kind: ${String(run.kind)}`);
}
