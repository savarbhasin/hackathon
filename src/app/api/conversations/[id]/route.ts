import { durableRunsEnabled } from "@/lib/queue/env";
import {
  deleteDurableConversation,
  getDurableConversation,
} from "@/lib/durable-chat-admission";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (durableRunsEnabled()) {
    try {
      const conversation = await getDurableConversation(id);
      if (!conversation) return Response.json({ error: "not_found", code: "not_found" }, { status: 404 });
      return Response.json(conversation);
    } catch {
      return Response.json({ error: "durable_read_failed", code: "durable_read_failed" }, { status: 503 });
    }
  }

  const conversation = await db.conversation.findUnique({
    where: { id },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(conversation);
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (durableRunsEnabled()) {
    try {
      const result = await deleteDurableConversation(id);
      if (result.kind === "active") {
        return Response.json({
          error: "active_run",
          code: "active_run",
          runId: result.run?._id,
          status: result.run?.status,
        }, { status: 409 });
      }
      if (result.kind === "missing") return Response.json({ error: "not_found", code: "not_found" }, { status: 404 });
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: "durable_delete_failed", code: "durable_delete_failed" }, { status: 503 });
    }
  }

  try {
    await db.conversation.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
