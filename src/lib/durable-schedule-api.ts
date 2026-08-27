import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { convexUrl } from "./queue/env";
import { enqueueAdmittedRun } from "./queue/producer";

const anyApi = api as unknown as Record<string, Record<string, any>>;
let client: ConvexHttpClient | undefined;

function convex(): ConvexHttpClient {
  return (client ??= new ConvexHttpClient(convexUrl(), { logger: false }));
}

function id(value: string): never {
  return value as never;
}

function ref(name: string): any {
  const fn = anyApi.schedules?.[name];
  if (!fn) throw new Error(`Convex function unavailable: schedules.${name}`);
  return fn;
}

export type DurableSchedule = Record<string, unknown> & {
  _id: string;
  deletedAt?: number;
  enabled: boolean;
  configRevision: number;
  syncState: string;
};

export async function listDurableSchedules(input: { limit: number; includeDisabled: boolean; includeDeleted?: boolean }): Promise<unknown[]> {
  const result = await convex().query(ref("list"), input);
  return Array.isArray(result) ? result : [];
}

export async function getDurableSchedule(scheduleId: string): Promise<DurableSchedule | null> {
  const result = await convex().query(ref("get"), { scheduleId: id(scheduleId) });
  return result && typeof result === "object" ? result as DurableSchedule : null;
}

export async function createDurableSchedule(input: {
  name: string;
  cronExpr: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  operationKey: string;
}): Promise<DurableSchedule> {
  return await convex().mutation(ref("create"), input) as DurableSchedule;
}

export async function updateDurableSchedule(input: {
  scheduleId: string;
  name?: string;
  cronExpr?: string;
  timezone?: string;
  prompt?: string;
  enabled?: boolean;
}): Promise<{ outcome?: string; schedule?: DurableSchedule }> {
  return await convex().mutation(ref("update"), {
    scheduleId: id(input.scheduleId),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.cronExpr !== undefined ? { cronExpr: input.cronExpr } : {}),
    ...(input.timezone !== undefined ? { timezone: input.timezone } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  }) as { outcome?: string; schedule?: DurableSchedule };
}

export async function deleteDurableSchedule(scheduleId: string): Promise<{ outcome?: string; schedulerId?: string }> {
  return await convex().mutation(ref("deleteSchedule"), { scheduleId: id(scheduleId) });
}

export type DurableRunAdmission = {
  outcome?: string;
  runId?: string;
  run?: Record<string, unknown>;
  reason?: string;
  queue?: unknown;
};

export async function runDurableScheduleNow(scheduleId: string, requestId: string): Promise<DurableRunAdmission> {
  const admission = await convex().mutation(ref("runNow"), {
    scheduleId: id(scheduleId),
    requestId,
  }) as DurableRunAdmission;
  const runId = admission.runId ?? (admission.run && typeof admission.run._id === "string" ? admission.run._id : undefined);
  if (!runId) return { ...admission, queue: { kind: "error", code: "enqueue_failed" } };
  try {
    return { ...admission, runId, queue: await enqueueAdmittedRun(runId) };
  } catch {
    // Admission is durable. A Redis outage must leave the run visibly queued;
    // callers receive a machine-readable 503 and can retry with the same UUID.
    return { ...admission, runId, queue: { kind: "error", code: "enqueue_failed" } };
  }
}
