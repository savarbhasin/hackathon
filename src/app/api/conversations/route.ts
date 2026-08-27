import { listDurableConversations } from "@/lib/durable-chat-admission";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await listDurableConversations());
  } catch {
    return Response.json({ error: "durable_read_failed", code: "durable_read_failed" }, { status: 503 });
  }
}
