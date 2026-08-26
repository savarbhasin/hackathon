import { db } from "./db";
import { orchestratorSay } from "./orchestrator";
import { SerialTaskQueue } from "./serial-task-queue";
import { durableRunsEnabled, durableSchedulesEnabled } from "./queue/env";

const scheduleRunQueue = new SerialTaskQueue();

export class ScheduleNotFoundError extends Error {
  constructor() {
    super("Schedule not found");
    this.name = "ScheduleNotFoundError";
  }
}

export class ScheduleDisabledError extends Error {
  constructor() {
    super("Schedule is cancelled");
    this.name = "ScheduleDisabledError";
  }
}

export class ScheduleRunnerUnavailableError extends Error {
  constructor() {
    super("Mission Control MCP server is unavailable");
    this.name = "ScheduleRunnerUnavailableError";
  }
}

export async function runScheduleNow(id: string) {
  // Durable schedules are admitted by Convex and delivered by the worker. Do
  // not let an API or stale legacy Cron callback invoke orchestratorSay when
  // durable ownership is enabled.
  if (durableRunsEnabled() && durableSchedulesEnabled()) {
    throw new ScheduleRunnerUnavailableError();
  }

  const requestedSchedule = await db.schedule.findUnique({ where: { id } });
  if (!requestedSchedule) throw new ScheduleNotFoundError();
  if (!requestedSchedule.enabled) throw new ScheduleDisabledError();

  return scheduleRunQueue.run(async () => {
    const schedule = await db.schedule.findUnique({ where: { id } });
    if (!schedule) throw new ScheduleNotFoundError();
    if (!schedule.enabled) throw new ScheduleDisabledError();

    try {
      const response = await fetch(`http://127.0.0.1:${process.env.MCP_PORT ?? "3100"}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error("MCP health check failed");
    } catch {
      throw new ScheduleRunnerUnavailableError();
    }

    await orchestratorSay(schedule.prompt);

    return db.schedule.update({
      where: { id },
      data: { lastRunAt: new Date() },
    });
  });
}
