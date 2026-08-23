import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(conversation);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await db.conversation.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
