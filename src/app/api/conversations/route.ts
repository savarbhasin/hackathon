import { durableRunsEnabled } from "@/lib/queue/env";
import { listDurableConversations } from "@/lib/durable-chat-admission";
import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  if (durableRunsEnabled()) {
    try {
      return Response.json(await listDurableConversations());
    } catch {
      return Response.json({ error: "durable_read_failed", code: "durable_read_failed" }, { status: 503 });
    }
  }

  const conversations = await db.conversation.findMany({
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      _count: { select: { messages: true } },
    },
  });
  return Response.json(conversations);
}
