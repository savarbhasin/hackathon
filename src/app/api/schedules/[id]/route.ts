import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const result = await db.schedule.updateMany({
    where: { id },
    data: { enabled: false },
  });
  if (result.count === 0) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true });
}
