import { randomUUID } from "node:crypto";
import { db } from "@/lib/db";
import { Cron } from "croner";
import { durableSchedulesActive } from "@/lib/queue/schedules";
import {
  createDurableSchedule,
  listDurableSchedules,
  type DurableSchedule,
} from "@/lib/durable-schedule-api";

export const runtime = "nodejs";
const MAX_LIMIT = 200;

type ScheduleInput = {
  name?: unknown;
  cronExpr?: unknown;
  timezone?: unknown;
  prompt?: unknown;
  enabled?: unknown;
  requestId?: unknown;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = boundedLimit(url.searchParams.get("limit"));
  const includeDisabled = url.searchParams.get("includeDisabled") !== "false";
  const includeDeleted = url.searchParams.get("includeDeleted") === "true";
  if (durableSchedulesActive()) {
    try {
      const schedules = await listDurableSchedules({ limit, includeDisabled, includeDeleted });
      return Response.json(schedules.map((schedule) => durableResponse(schedule as DurableSchedule)));
    } catch {
      return Response.json({ error: "durable_unavailable" }, { status: 503 });
    }
  }

  const schedules = await db.schedule.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  return Response.json(schedules.map((schedule) => ({
    ...schedule,
    nextRuns: schedule.enabled ? nextRuns(schedule.cronExpr) : [],
    calendarRuns: schedule.enabled && url.searchParams.has("month") ? runsInMonth(schedule.cronExpr, requestedMonth(url.searchParams.get("month"))) : [],
  })));
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as ScheduleInput | null;
  const input = validateScheduleInput(body, { requireCron: true });
  if (!input.ok) return Response.json({ error: "invalid_request", fields: input.fields }, { status: 400 });

  const operationKey = requestKey(req, body?.requestId);
  if (durableSchedulesActive()) {
    try {
      const schedule = await createDurableSchedule({ ...input.value, operationKey });
      // A deduped operation key may point at a tombstone. Never present that
      // result as a newly-created enabled schedule.
      if (schedule.deletedAt !== undefined) {
        return Response.json({ error: "conflict", reason: "operation_key_references_deleted_schedule", schedule: durableResponse(schedule) }, { status: 409 });
      }
      return Response.json({ schedule: durableResponse(schedule), configRevision: schedule.configRevision ?? 1, syncState: schedule.syncState ?? "pending" }, { status: 201 });
    } catch (error) {
      return durableError(error);
    }
  }

  const schedule = await db.schedule.create({ data: {
    name: input.value.name,
    cronExpr: input.value.cronExpr,
    prompt: input.value.prompt,
    enabled: input.value.enabled,
  } });
  return Response.json(schedule, { status: 201 });
}

function boundedLimit(value: string | null): number {
  const parsed = value ? Number(value) : 100;
  return Number.isFinite(parsed) ? Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed))) : 100;
}

function requestKey(req: Request, bodyValue: unknown): string {
  const bodyKey = typeof bodyValue === "string" ? bodyValue.trim() : "";
  const headerKey = req.headers.get("idempotency-key")?.trim() || req.headers.get("x-request-id")?.trim() || "";
  const value = bodyKey || headerKey;
  return value && value.length <= 256 ? value : randomUUID();
}

function validateScheduleInput(body: ScheduleInput | null, options: { requireCron: boolean }): { ok: true; value: { name: string; cronExpr: string; timezone: string; prompt: string; enabled: boolean } } | { ok: false; fields: string[] } {
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const cronExpr = typeof body?.cronExpr === "string" ? body.cronExpr.trim() : "";
  const timezone = typeof body?.timezone === "string" ? body.timezone.trim() : "UTC";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const fields: string[] = [];
  if (!name || name.length > 120) fields.push("name");
  if (options.requireCron && (!cronExpr || cronExpr.length > 200 || !validCronExpression(cronExpr))) fields.push("cronExpr");
  if (!timezone || timezone.length > 100 || !validTimezone(timezone)) fields.push("timezone");
  if (!prompt || prompt.length > 4_000) fields.push("prompt");
  if (body?.enabled !== undefined && typeof body.enabled !== "boolean") fields.push("enabled");
  if (fields.length) return { ok: false, fields };
  return { ok: true, value: { name, cronExpr, timezone, prompt, enabled: body?.enabled ?? true } };
}

function durableResponse(schedule: DurableSchedule): Record<string, unknown> {
  return { ...schedule, id: typeof schedule._id === "string" ? schedule._id : undefined };
}

function durableError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (/conflict|stale|revision/i.test(message)) return Response.json({ error: "conflict" }, { status: 409 });
  if (/invalid|argument/i.test(message)) return Response.json({ error: "invalid_request" }, { status: 400 });
  return Response.json({ error: "durable_unavailable" }, { status: 503 });
}

function validCronExpression(cronExpr: string): boolean {
  try { new Cron(cronExpr); return true; } catch { return false; }
}

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return true; } catch { return false; }
}

function nextRuns(cronExpr: string): string[] {
  try { return new Cron(cronExpr).nextRuns(4).map((run) => run.toISOString()); } catch { return []; }
}

function requestedMonth(value: string | null): Date | null {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function runsInMonth(cronExpr: string, month: Date | null): string[] {
  if (!month) return [];
  try {
    const cron = new Cron(cronExpr);
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    let cursor = new Date(month.getTime() - 1_000);
    const runs: string[] = [];
    for (let count = 0; count < 1_000; count += 1) {
      const next = cron.nextRun(cursor);
      if (!next || next >= end) break;
      runs.push(next.toISOString());
      cursor = next;
    }
    return runs;
  } catch { return []; }
}
