import { Queue, QueueEvents, type JobsOptions } from "bullmq";
import { createRedisConnection } from "./redis";
import { AGENT_RUNS_QUEUE, type AgentRunJobData } from "./types";

const RUN_JOB_NAME = "agent-run";

/** Bounded delivery retries; provider stream loss is retried by attaching to the persisted turn. */
export const agentRunJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400, count: 5_000 },
};

export function createAgentRunsQueue(): Queue<AgentRunJobData> {
  return new Queue<AgentRunJobData>(AGENT_RUNS_QUEUE, { connection: createRedisConnection("producer") });
}

export function createAgentRunsQueueEvents(): QueueEvents {
  return new QueueEvents(AGENT_RUNS_QUEUE, { connection: createRedisConnection("events") });
}

export type EnqueueResult =
  | { kind: "enqueued"; jobId: string }
  | { kind: "already_present"; jobId: string; state: string | undefined };

/**
 * Queue data intentionally contains nothing except the durable Convex run ID.
 * A duplicate `add` returns/retains the existing BullMQ job; it cannot create a
 * second logical run because the stable BullMQ job ID equals `runId`.
 */
export async function enqueueAgentRun(queue: Queue<AgentRunJobData>, runId: string): Promise<EnqueueResult> {
  const existing = await queue.getJob(runId);
  if (existing) return { kind: "already_present", jobId: runId, state: await existing.getState() };

  const job = await queue.add(RUN_JOB_NAME, { runId }, { ...agentRunJobOptions, jobId: runId });
  return { kind: "enqueued", jobId: job.id ?? runId };
}

/**
 * A pause completes the prior job. To enqueue its resume with the same stable
 * run ID, the caller must first verify Convex has moved that run back to queued
 * or enqueued, then remove the retained completed delivery before calling add.
 * Never call this for terminal runs; their completed job is retained for debug.
 */
export async function replaceCompletedDeliveryForResume(queue: Queue<AgentRunJobData>, runId: string): Promise<boolean> {
  const existing = await queue.getJob(runId);
  if (!existing || (await existing.getState()) !== "completed") return false;
  await existing.remove();
  return true;
}
