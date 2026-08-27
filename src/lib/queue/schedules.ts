import type { Job, Queue } from "bullmq";
import { agentRunJobOptions, createAgentRunsQueue } from "./agent-runs";
import { enqueueAdmittedRun } from "./producer";
import { ConvexAgentRunStore, ConvexScheduleStore } from "./convex-agent-runs";
import { workerLog, safeError } from "./log";
import type { AgentRunJobData, ScheduleFireJobData } from "./types";
import { SCHEDULE_FIRE_JOB_NAME } from "./types";

export const SCHEDULE_SCHEDULER_PREFIX = "mission-control:schedule:";
export const SCHEDULE_RECONCILIATION_LIMIT = 500;
const RECONCILIATION_INTERVAL_MS = 30_000;

function boundedError(error: unknown): string {
  const value = safeError(error);
  const message = error instanceof Error ? error.message : "schedule synchronization failed";
  return `${value.name}: ${message}`.slice(0, 2_000);
}

function validTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * BullMQ v5 creates scheduler occurrences with IDs of the form
 * `repeat:<schedulerId>:<nextMillis>` and sets `opts.prevMillis` to that same
 * scheduled UTC timestamp. The occurrence ID is the primary stable key;
 * `prevMillis` is only used as the intended-fire timestamp.
 */
export function scheduleFireIdentity(job: Pick<Job<AgentRunJobData>, "id" | "repeatJobKey" | "opts">): {
  fireKey: string;
  intendedFireAt?: number;
} {
  const occurrenceId = typeof job.id === "string" && job.id.length > 0
    ? job.id
    : `${job.repeatJobKey ?? "unknown"}:${String((job.opts as { prevMillis?: unknown }).prevMillis ?? "unknown")}`;
  const opts = job.opts as { prevMillis?: unknown };
  let intendedFireAt = validTimestamp(opts.prevMillis);
  if (intendedFireAt === undefined) {
    const match = occurrenceId.match(/:(\d+)$/);
    if (match) intendedFireAt = validTimestamp(Number(match[1]));
  }
  return { fireKey: `bullmq:${occurrenceId}`, ...(intendedFireAt !== undefined ? { intendedFireAt } : {}) };
}

function isScheduleFireData(data: AgentRunJobData): data is ScheduleFireJobData {
  const value = data as Partial<ScheduleFireJobData>;
  return typeof value.scheduleId === "string"
    && typeof value.schedulerId === "string"
    && typeof value.configRevision === "number";
}

/**
 * Owns the BullMQ Job Scheduler projection and schedule.fire admission path.
 * The worker constructs this service as the sole schedule owner.
 */
export class BullMqScheduleService {
  readonly queue: Queue<AgentRunJobData>;
  private reconciling = false;
  private activeReconcile: Promise<void> | undefined;
  private interval: NodeJS.Timeout | undefined;
  private started = false;
  private closed = false;

  constructor(
    private readonly scheduleStore = new ConvexScheduleStore(),
    private readonly runStore = new ConvexAgentRunStore(),
    queue: Queue<AgentRunJobData> = createAgentRunsQueue(),
  ) {
    this.queue = queue;
  }

  async start(): Promise<void> {
    if (this.closed || this.started) return;
    this.started = true;
    try {
      await this.reconcile();
    } catch (error) {
      workerLog("schedule.reconcile_failed", { ...safeError(error) });
    }
    this.interval = setInterval(() => {
      void this.reconcile().catch((error) => workerLog("schedule.reconcile_failed", { ...safeError(error) }));
    }, RECONCILIATION_INTERVAL_MS);
    this.interval.unref?.();
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    if (this.activeReconcile) return this.activeReconcile;
    const active = this.reconcileCycle();
    this.activeReconcile = active;
    try {
      await active;
    } finally {
      if (this.activeReconcile === active) this.activeReconcile = undefined;
    }
  }

  private async reconcileCycle(): Promise<void> {
    if (this.closed || this.reconciling) return;
    this.reconciling = true;
    try {
      let snapshot: Awaited<ReturnType<ConvexScheduleStore["reconciliationSnapshot"]>>;
      try {
        snapshot = await this.scheduleStore.reconciliationSnapshot(SCHEDULE_RECONCILIATION_LIMIT);
      } catch (error) {
        workerLog("schedule.reconcile_failed", { ...safeError(error) });
        return;
      }

      const desired = new Set<string>();
      for (const schedule of snapshot.schedules.slice(0, SCHEDULE_RECONCILIATION_LIMIT)) {
        const schedulerId = schedule.schedulerId || `${SCHEDULE_SCHEDULER_PREFIX}${schedule._id}`;
        desired.add(schedulerId);
        try {
          await this.queue.upsertJobScheduler(
            schedulerId,
            { pattern: schedule.cronExpr, tz: schedule.timezone },
            {
              name: SCHEDULE_FIRE_JOB_NAME,
              data: { scheduleId: schedule._id, configRevision: schedule.configRevision, schedulerId },
              opts: agentRunJobOptions,
            },
          );
          await this.scheduleStore.markSyncSuccess({
            scheduleId: schedule._id,
            configRevision: schedule.configRevision,
            schedulerId,
          });
        } catch (error) {
          workerLog("schedule.sync_failed", {
            scheduleId: schedule._id,
            schedulerId,
            configRevision: schedule.configRevision,
            ...safeError(error),
          });
          try {
            await this.scheduleStore.markSyncFailure({
              scheduleId: schedule._id,
              configRevision: schedule.configRevision,
              schedulerId,
              error: boundedError(error),
            });
          } catch (markError) {
            workerLog("schedule.sync_failure_checkpoint_failed", { scheduleId: schedule._id, ...safeError(markError) });
          }
        }
      }

      for (const tombstone of snapshot.tombstones.slice(0, SCHEDULE_RECONCILIATION_LIMIT)) {
        // Never remove a scheduler outside this service's namespace.
        if (tombstone.schedulerId?.startsWith(SCHEDULE_SCHEDULER_PREFIX)) {
          await this.removeScheduler(tombstone.schedulerId);
        }
      }

      // Do not infer deletion from absence in the bounded desired-state
      // snapshot. A valid schedule beyond the snapshot cap must keep its
      // scheduler. Deletions are explicit tombstones and are removed above,
      // with the ownership-prefix check retained there.
      workerLog("schedule.reconciled", {
        enabled: desired.size,
        tombstones: snapshot.tombstones.length,
      });
    } finally {
      this.reconciling = false;
    }
  }

  private async removeScheduler(schedulerId: string): Promise<void> {
    try {
      await this.queue.removeJobScheduler(schedulerId);
    } catch (error) {
      workerLog("schedule.remove_failed", { schedulerId, ...safeError(error) });
    }
  }

  /** Admit a fire, then enqueue the resulting run before acknowledging the job. */
  async deliverFire(job: Job<AgentRunJobData>): Promise<void> {
    if (!isScheduleFireData(job.data)) throw new Error("Invalid schedule.fire payload");
    const data = job.data;
    const identity = scheduleFireIdentity(job);
    const admission = await this.scheduleStore.createScheduledRun({
      scheduleId: data.scheduleId,
      fireKey: identity.fireKey,
      ...(identity.intendedFireAt !== undefined ? { intendedFireAt: identity.intendedFireAt } : {}),
      externalId: `schedule:${data.scheduleId}:${identity.fireKey}`,
    });
    const runId = admission.runId ?? admission.run?._id;
    if (!runId) {
      if (admission.outcome === "disabled" || admission.outcome === "not_found") {
        workerLog("schedule.fire_ignored", { scheduleId: data.scheduleId, outcome: admission.outcome });
        return;
      }
      throw new Error(`Schedule fire admission failed: ${admission.reason ?? admission.outcome ?? "unknown"}`);
    }
    await enqueueAdmittedRun(runId, { store: this.runStore, queue: this.queue });
    workerLog("schedule.fire_admitted", {
      scheduleId: data.scheduleId,
      schedulerId: data.schedulerId,
      configRevision: data.configRevision,
      runId,
      fireKey: identity.fireKey,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    if (this.activeReconcile) await this.activeReconcile;
    await this.queue.close();
  }
}
