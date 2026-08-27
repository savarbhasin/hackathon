import { durableDispatchTask, durableResolvePause, durableRetryTask } from "@/lib/durable-task-engine";
import { durableTaskActionResponse, getDurableTaskDetail } from "@/lib/durable-task-api";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const task = await getDurableTaskDetail(id);
    if (!task) return Response.json({ error: "not_found" }, { status: 404 });
    return Response.json(task);
  } catch {
    return Response.json({ error: "task_unavailable" }, { status: 503 });
  }
}

interface Body {
  action?: "dispatch" | "retry" | "approve" | "deny" | "answer";
  allow?: boolean;
  reason?: string;
  content?: string;
  selector?: string;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as Body | null;
  if (!body?.action) return Response.json({ error: "action required" }, { status: 400 });

  if ((body.action === "approve" || body.action === "deny" || body.action === "answer") && !body.selector?.trim()) {
    return Response.json({ error: "selector_required", code: "selector_required" }, { status: 400 });
  }
  const action = body.action === "deny" ? "approve" : body.action;
  if (action === "answer" && !body.content?.trim()) {
    return Response.json({ error: "answer_content_required", code: "answer_content_required" }, { status: 400 });
  }
  try {
    const result = action === "dispatch"
      ? await durableDispatchTask(id)
      : action === "retry"
        ? await durableRetryTask(id)
        : await durableResolvePause(id, action === "approve"
          ? { kind: "approve", allow: body.action === "deny" ? false : body.allow !== false, reason: body.reason, selector: body.selector!.trim() }
          : { kind: "answer", content: body.content!.trim(), selector: body.selector!.trim() });
    const detail = await getDurableTaskDetail(id);
    const response = durableTaskActionResponse(id, body.action, result, detail);
    return Response.json(response, { status: result.ok ? 202 : result.reason === "not_found" ? 404 : 409 });
  } catch {
    return Response.json({ error: "action_failed", code: "action_failed", taskId: id }, { status: 503 });
  }
}
