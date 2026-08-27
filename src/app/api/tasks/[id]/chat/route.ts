import { appendDurableTaskEvent, durableFollowupTask } from "@/lib/durable-task-engine";

export const runtime = "nodejs";
export const maxDuration = 800;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { message?: string; clientMessageId?: string } | null;
  const message = body?.message?.trim();
  const clientMessageId = body?.clientMessageId?.trim() || undefined;
  if (!message) return Response.json({ error: "message_required" }, { status: 400 });
  const accepted = await durableFollowupTask(id, message, clientMessageId);
  if (!accepted.ok) return Response.json({ error: accepted.reason ?? "followup_rejected" }, { status: 409 });
  await appendDurableTaskEvent(id, "chat.user", { content: message, ...(clientMessageId ? { clientMessageId } : {}) }, `chat-user:${clientMessageId ?? accepted.runId}`);
  return Response.json({ ok: true, runId: accepted.runId }, { status: 202 });
}
