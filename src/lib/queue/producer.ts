import { type Queue } from "bullmq";
import { createAgentRunsQueue, enqueueAgentRun, replaceCompletedDeliveryForResume, type EnqueueResult } from "./agent-runs";
import { ConvexAgentRunStore } from "./convex-agent-runs";
import type { AgentRunJobData, AgentRunKind, AgentRunRecord, AgentRunStore, PendingAction } from "./types";

export type { EnqueueResult } from "./agent-runs";

export type CreateDurableRunInput = {
  externalId: string;
  kind: AgentRunKind;
  input: unknown;
  conversationId?: string;
  taskId?: string;
  scheduleId?: string;
  sessionId?: string;
  turnId?: string;
};

export type EnqueueDependencies = { store?: AgentRunStore; queue?: Queue<AgentRunJobData> };

/**
 * Create a run in Convex and deliver it to BullMQ.
 */
export async function createAndEnqueueDurableRun(
  input: CreateDurableRunInput,
  dependencies: EnqueueDependencies = {},
): Promise<{ run: AgentRunRecord; queue: EnqueueResult }> {
  const store = dependencies.store ?? new ConvexAgentRunStore();
  const queue = dependencies.queue ?? createAgentRunsQueue();
  try {
    const run = await store.create(input);
    const queued = await enqueueAdmittedRun(run._id, { store, queue });
    return { run, queue: queued };
  } finally {
    if (!dependencies.queue) await queue.close();
  }
}

/**
 * Deliver a run that was already admitted in Convex. The queue payload remains
 * only `{runId}` and Convex is marked enqueued only after Redis accepts it.
 */
export async function enqueueAdmittedRun(
  runId: string,
  dependencies: EnqueueDependencies = {},
): Promise<EnqueueResult> {
  const store = dependencies.store ?? new ConvexAgentRunStore();
  const queue = dependencies.queue ?? createAgentRunsQueue();
  try {
    const run = await store.get(runId);
    if (!run || (run.status !== "queued" && run.status !== "enqueued")) {
      return { kind: "already_present", jobId: runId, state: run?.status };
    }
    const queued = await enqueueAgentRun(queue, runId);
    await store.markEnqueued(runId);
    return queued;
  } finally {
    if (!dependencies.queue) await queue.close();
  }
}

/**
 * `queueResume` has already durably returned this run to queued. Because pause
 * jobs are retained as completed for debugging, remove only that completed
 * delivery before adding the stable same-run job ID again. Never use this for
 * terminal runs; their delivery remains retained.
 */
export async function queueResumeAndEnqueue(
  input: { runId: string; pendingAction?: PendingAction[]; pendingActionSelector?: string; resumeInput: unknown },
  dependencies: EnqueueDependencies = {}
): Promise<EnqueueResult> {
  const store = dependencies.store ?? new ConvexAgentRunStore();
  const accepted = await store.queueResume(input);
  if (!accepted) return { kind: "already_present", jobId: input.runId, state: "resume_rejected" };
  return enqueueAcceptedResume(input.runId, { store, queue: dependencies.queue });
}

export async function enqueueAcceptedResume(
  runId: string,
  dependencies: EnqueueDependencies = {},
): Promise<EnqueueResult> {
  const store = dependencies.store ?? new ConvexAgentRunStore();
  const queue = dependencies.queue ?? createAgentRunsQueue();
  try {
    const run = await store.get(runId);
    if (!run || (run.status !== "queued" && run.status !== "enqueued")) {
      return { kind: "already_present", jobId: runId, state: run?.status };
    }
    await replaceCompletedDeliveryForResume(queue, runId);
    return await enqueueAdmittedRun(runId, { store, queue });
  } finally {
    if (!dependencies.queue) await queue.close();
  }
}

/** Explicit name for callers that have already completed selector admission. */
export const enqueueAdmittedResume = enqueueAcceptedResume;
