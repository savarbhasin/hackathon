import { Worker } from "bullmq";
import { createAgentRunsQueueEvents } from "../src/lib/queue/agent-runs";
import { ConvexAgentRunStore } from "../src/lib/queue/convex-agent-runs";
import { BullMqScheduleService } from "../src/lib/queue/schedules";
import { requireWorkerEnvironment } from "../src/lib/queue/env";
import { workerLog, safeError } from "../src/lib/queue/log";
import { createRedisConnection } from "../src/lib/queue/redis";
import { processAgentRun } from "../src/lib/queue/run-worker";
import { AGENT_RUNS_QUEUE, SCHEDULE_FIRE_JOB_NAME, type AgentRunJobData } from "../src/lib/queue/types";

const workerId = process.env.WORKER_ID ?? `agent-runs-${process.pid}`;
const concurrency = Number.parseInt(process.env.WORKER_CONCURRENCY ?? "2", 10);
if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("WORKER_CONCURRENCY must be a positive integer");

async function main(): Promise<void> {
  requireWorkerEnvironment();
  const store = new ConvexAgentRunStore();
  const scheduleService = new BullMqScheduleService(undefined, store);
  await scheduleService.start();

  let shuttingDown = false;
  const controllers = new Set<AbortController>();
  const worker = new Worker<AgentRunJobData>(
    AGENT_RUNS_QUEUE,
    async (job) => {
      if (shuttingDown) throw new Error("Worker is shutting down");
      if (job.name === SCHEDULE_FIRE_JOB_NAME) {
        // This awaits both Convex admission and run enqueue. No prompt enters
        // the BullMQ payload or a detached background promise.
        await scheduleService.deliverFire(job);
        return;
      }
      const data = job.data as { runId?: unknown };
      if (typeof data.runId !== "string" || data.runId.length === 0) throw new Error("Invalid agent-run payload");
      const controller = new AbortController();
      controllers.add(controller);
      try {
        await processAgentRun(store, data.runId, { workerId, signal: controller.signal });
      } finally {
        controllers.delete(controller);
      }
    },
    { connection: createRedisConnection("worker"), concurrency },
  );
  const queueEvents = createAgentRunsQueueEvents();

  worker.on("ready", () => workerLog("worker.ready", { workerId, concurrency }));
  worker.on("active", (job) => workerLog("job.active", {
    workerId,
    jobId: job.id ?? null,
    jobName: job.name,
    runId: typeof (job.data as { runId?: unknown }).runId === "string" ? (job.data as { runId: string }).runId : null,
    attempt: job.attemptsMade + 1,
  }));
  worker.on("completed", (job) => workerLog("job.completed", {
    workerId,
    jobId: job.id ?? null,
    jobName: job.name,
    runId: typeof (job.data as { runId?: unknown }).runId === "string" ? (job.data as { runId: string }).runId : null,
  }));
  worker.on("failed", (job, error) => workerLog("job.failed", {
    workerId,
    jobId: job?.id ?? null,
    jobName: job?.name ?? null,
    runId: typeof (job?.data as { runId?: unknown } | undefined)?.runId === "string" ? (job?.data as { runId: string }).runId : null,
    ...safeError(error),
  }));
  worker.on("error", (error) => workerLog("worker.error", { workerId, ...safeError(error) }));
  queueEvents.on("stalled", ({ jobId }) => workerLog("job.stalled", { workerId, jobId }));
  queueEvents.on("failed", ({ jobId, failedReason }) => workerLog("queue.failed", { workerId, jobId, failedReasonLength: failedReason.length }));

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    workerLog("worker.shutdown_started", { workerId, signal, activeSubscriptions: controllers.size });
    for (const controller of controllers) controller.abort();
    await worker.close(); // Stops new claims and waits for active jobs to checkpoint/release.
    await queueEvents.close();
    await scheduleService.close();
    workerLog("worker.shutdown_complete", { workerId, signal });
  }

  process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)).catch(() => process.exit(1)));
  process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)).catch(() => process.exit(1)));
}

void main().catch((error) => {
  workerLog("worker.start_failed", { workerId, ...safeError(error) });
  process.exitCode = 1;
});
