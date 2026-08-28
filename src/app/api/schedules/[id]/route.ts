import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import {
  deleteDurableSchedule,
  getDurableSchedule,
  runDurableScheduleNow,
  updateDurableSchedule,
  type DurableRunAdmission,
  type DurableSchedule,
} from "@/lib/durable-schedule-api";

export const runtime = "nodejs";
export const maxDuration = 300;

type Params = { params: Promise<{ id: string }> };
type SchedulePatch = { name?: unknown; cronExpr?: unknown; timezone?: unknown; prompt?: unknown; enabled?: unknown; configRevision?: unknown };

export async function GET(_req: Request, ctx: Params) {
  const { id } = await ctx.params;
  try {
    const schedule = await getDurableSchedule(id);
    if (!schedule || schedule.deletedAt !== undefined) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(durableResponse(schedule));
  } catch {
    return Response.json({ error: "durable_unavailable" }, { status: 503 });
  }
}

/** Run now is admission + short queue delivery; it never waits for execution. */
export async function POST(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { requestId?: unknown } | null;
  const requestId = requestKey(req, body?.requestId);
  try {
    const schedule = await getDurableSchedule(id);
    const result = await runDurableScheduleNow(id, requestId);
    return runAdmissionResponse(result, schedule);
  } catch (error) {
    return durableError(error);
  }
}

export async function PATCH(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as SchedulePatch | null;
  const fields = validatePatch(body);
  if (!fields.ok) return Response.json({ error: "invalid_request", fields: fields.fields }, { status: 400 });

  try {
    const result = await updateDurableSchedule({ scheduleId: id, ...fields.value });
    return mutationResponse(result, "updated");
  } catch (error) {
    return durableError(error);
  }
}

export async function PUT(req: Request, ctx: Params) {
  return PATCH(req, ctx);
}

export async function DELETE(_req: Request, ctx: Params) {
  const { id } = await ctx.params;
  try {
    const current = await getDurableSchedule(id);
    if (!current) return Response.json({ error: "not_found" }, { status: 404 });
    const result = await deleteDurableSchedule(id);
    if (result.outcome === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
    const schedule = current.deletedAt !== undefined ? current : {
      ...current,
      enabled: false,
      deletedAt: Date.now(),
      configRevision: current.configRevision + 1,
      syncState: "pending",
    };
    return Response.json({ outcome: result.outcome ?? "deleted", scheduleId: id, schedule: durableResponse(schedule), configRevision: schedule.configRevision, syncState: schedule.syncState });
  } catch (error) {
    return durableError(error);
  }
}

function requestKey(req: Request, bodyValue: unknown): string {
  const bodyKey = typeof bodyValue === "string" ? bodyValue.trim() : "";
  const value = bodyKey || req.headers.get("idempotency-key")?.trim() || req.headers.get("x-request-id")?.trim() || "";
  return value && value.length <= 256 ? value : randomUUID();
}

function validatePatch(body: SchedulePatch | null): { ok: true; value: { configRevision: number; name?: string; cronExpr?: string; timezone?: string; prompt?: string; enabled?: boolean } } | { ok: false; fields: string[] } {
  const value: { configRevision: number; name?: string; cronExpr?: string; timezone?: string; prompt?: string; enabled?: boolean } = {
    configRevision: typeof body?.configRevision === "number" ? body.configRevision : NaN,
  };
  const fields: string[] = [];
  if (body?.name !== undefined) { if (typeof body.name !== "string" || !(value.name = body.name.trim()) || value.name.length > 120) fields.push("name"); }
  if (body?.cronExpr !== undefined) { if (typeof body.cronExpr !== "string" || !(value.cronExpr = body.cronExpr.trim()) || value.cronExpr.length > 200 || !validCronExpression(value.cronExpr)) fields.push("cronExpr"); }
  if (body?.timezone !== undefined) { if (typeof body.timezone !== "string" || !(value.timezone = body.timezone.trim()) || value.timezone.length > 100 || !validTimezone(value.timezone)) fields.push("timezone"); }
  if (body?.prompt !== undefined) { if (typeof body.prompt !== "string" || !(value.prompt = body.prompt.trim()) || value.prompt.length > 4_000) fields.push("prompt"); }
  if (body?.enabled !== undefined) { if (typeof body.enabled !== "boolean") fields.push("enabled"); else value.enabled = body.enabled; }
  if (typeof body?.configRevision !== "number" || !Number.isSafeInteger(body.configRevision) || body.configRevision < 1) fields.push("configRevision");
  if (fields.length || Object.keys(value).length === 1) return { ok: false, fields: fields.length ? fields : ["name", "prompt"] };
  return { ok: true, value };
}

function durableResponse(schedule: DurableSchedule): Record<string, unknown> { return { ...schedule, id: typeof schedule._id === "string" ? schedule._id : undefined }; }

function validCronExpression(cronExpr: string): boolean {
  try { new Cron(cronExpr); return true; } catch { return false; }
}

function validTimezone(timezone: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(); return true; } catch { return false; }
}

function mutationResponse(result: { outcome?: string; configRevision?: number; schedule?: DurableSchedule }, fallback: string): Response {
  if (result.outcome === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
  if (result.outcome === "conflict" || result.outcome === "stale") {
    const configRevision = result.configRevision ?? result.schedule?.configRevision;
    return Response.json({
      error: "conflict",
      reason: result.outcome === "stale" ? "stale_revision" : undefined,
      ...(configRevision !== undefined ? { configRevision } : {}),
      ...(result.schedule ? { schedule: durableResponse(result.schedule) } : {}),
    }, { status: 409 });
  }
  if (result.outcome === "invalid_state") return Response.json({ error: "invalid_state" }, { status: 422 });
  const schedule = result.schedule;
  return Response.json({ outcome: result.outcome ?? fallback, ...(schedule ? { schedule: durableResponse(schedule), configRevision: schedule.configRevision, syncState: schedule.syncState } : {}) });
}

function runAdmissionResponse(result: DurableRunAdmission, schedule: DurableSchedule | null): Response {
  if (result.outcome === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
  if (result.outcome === "disabled") return Response.json({ error: "disabled" }, { status: 409 });
  if (result.outcome === "conflict") return Response.json({ error: "conflict", reason: result.reason }, { status: 409 });
  if (result.outcome === "invalid_state") return Response.json({ error: "invalid_state", reason: result.reason }, { status: 422 });
  if ((result.queue as { code?: string } | undefined)?.code === "enqueue_failed") return Response.json({ ...result, schedule: schedule ? durableResponse(schedule) : null, error: "enqueue_failed", status: "queued" }, { status: 503 });
  const status = result.run && typeof result.run.status === "string" ? result.run.status : "queued";
  return Response.json({ ...result, schedule: schedule ? durableResponse(schedule) : null, status, queue: result.queue }, { status: result.outcome === "created" ? 202 : 200 });
}

function durableError(error: unknown): Response {
  const message = error instanceof Error ? error.message : "";
  if (/not.?found/i.test(message)) return Response.json({ error: "not_found" }, { status: 404 });
  if (/disabled/i.test(message)) return Response.json({ error: "disabled" }, { status: 409 });
  if (/stale|revision|conflict/i.test(message)) return Response.json({ error: "conflict", reason: "stale_revision" }, { status: 409 });
  return Response.json({ error: "durable_unavailable" }, { status: 503 });
}
