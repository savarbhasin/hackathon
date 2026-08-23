import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
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
