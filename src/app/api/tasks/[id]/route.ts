import { db } from "@/lib/db";
import { dispatchTask, resolvePause } from "@/lib/engine";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await db.task.findUnique({
    where: { id },
    include: { events: { orderBy: { seq: "desc" }, take: 60 } },
  });
  if (!task) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(task);
}

interface Body {
  action?: "dispatch" | "approve" | "answer";
  allow?: boolean;
  reason?: string;
  content?: string;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.action) return Response.json({ error: "action required" }, { status: 400 });

  switch (body.action) {
    case "dispatch": {
      const result = await dispatchTask(id);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    case "approve":
    case "answer": {
      const result = await resolvePause(
        id,
        body.action === "approve"
          ? { kind: "approve", allow: body.allow !== false, reason: body.reason }
          : { kind: "answer", content: body.content ?? "" }
      );
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}
