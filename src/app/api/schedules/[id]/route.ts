import { db } from "@/lib/db";
import { runScheduleNow, ScheduleDisabledError, ScheduleNotFoundError, ScheduleRunnerUnavailableError } from "@/lib/schedule-runner";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return Response.json(await runScheduleNow(id));
  } catch (error) {
    if (error instanceof ScheduleNotFoundError) return Response.json({ error: "not_found" }, { status: 404 });
    if (error instanceof ScheduleDisabledError) return Response.json({ error: "schedule_cancelled" }, { status: 409 });
    if (error instanceof ScheduleRunnerUnavailableError) return Response.json({ error: "runner_unavailable" }, { status: 503 });
    return Response.json({ error: "run_failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { name?: unknown; prompt?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim().slice(0, 4_000) : "";
  if (!name || !prompt) return Response.json({ error: "name and prompt are required" }, { status: 400 });
  try {
    const schedule = await db.schedule.update({ where: { id }, data: { name, prompt } });
    return Response.json(schedule);
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await db.schedule.updateMany({
    where: { id },
    data: { enabled: false },
  });
  if (result.count === 0) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
