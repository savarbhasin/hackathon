import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const document = await db.document.findUnique({
    where: { id },
    include: {
      mission: { select: { id: true, title: true } },
      task: { select: { id: true, title: true, role: true } },
    },
  });
  if (!document) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(document);
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    title?: string;
    content?: string;
  } | null;
  if (!body || (body.title === undefined && body.content === undefined)) {
    return Response.json({ error: "title or content required" }, { status: 400 });
  }
  try {
    const document = await db.document.update({
      where: { id },
      data: {
        ...(body.title !== undefined ? { title: body.title.slice(0, 160) } : {}),
        ...(body.content !== undefined ? { content: body.content } : {}),
      },
    });
    return Response.json(document);
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    await db.document.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
