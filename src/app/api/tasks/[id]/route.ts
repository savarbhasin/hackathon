import { dispatchTask, resolvePause, retryTask } from "@/lib/engine";
import { durableRunsEnabled } from "@/lib/queue/env";
import { durableTaskActionResponse, getDurableTaskDetail } from "@/lib/durable-task-api";
import { getTaskDetail } from "@/lib/task-detail";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (durableRunsEnabled()) {
    try {
      const task = await getDurableTaskDetail(id);
      if (!task) return Response.json({ error: "not_found", mode: "durable" }, { status: 404 });
      return Response.json(task);
    } catch {
      return Response.json({ error: "durable_task_unavailable", mode: "durable" }, { status: 503 });
    }
  }
  const task = await getTaskDetail(id);
  if (!task) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json(task);
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

  if (durableRunsEnabled()) {
    if ((body.action === "approve" || body.action === "deny" || body.action === "answer") && !body.selector?.trim()) {
      return Response.json({ error: "selector_required", code: "selector_required", mode: "durable" }, { status: 400 });
    }
    const action = body.action === "deny" ? "approve" : body.action;
    if (action === "answer" && !body.content?.trim()) {
      return Response.json({ error: "answer_content_required", code: "answer_content_required", mode: "durable" }, { status: 400 });
    }
    try {
      const result = action === "dispatch"
        ? await dispatchTask(id)
        : action === "retry"
          ? await retryTask(id)
          : await resolvePause(id, action === "approve"
            ? { kind: "approve", allow: body.action === "deny" ? false : body.allow !== false, reason: body.reason, selector: body.selector!.trim() }
            : { kind: "answer", content: body.content!.trim(), selector: body.selector!.trim() });
      const detail = await getDurableTaskDetail(id);
      const response = durableTaskActionResponse(id, body.action, result, detail);
      return Response.json(response, { status: result.ok ? 202 : result.reason === "not_found" ? 404 : 409 });
    } catch {
      return Response.json({ error: "durable_action_failed", code: "durable_action_failed", mode: "durable", taskId: id }, { status: 503 });
    }
  }

  switch (body.action) {
    case "dispatch": {
      const result = await dispatchTask(id);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    case "retry": {
      const result = await retryTask(id);
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    case "approve":
    case "deny":
    case "answer": {
      if (body.action === "answer" && !body.content?.trim()) {
        return Response.json({ error: "answer content required" }, { status: 400 });
      }
      const result = await resolvePause(
        id,
        body.action === "approve" || body.action === "deny"
          ? { kind: "approve", allow: body.action === "deny" ? false : body.allow !== false, reason: body.reason }
          : { kind: "answer", content: body.content!.trim() }
      );
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}
