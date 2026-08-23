import { db } from "@/lib/db";
import { dispatchTask, resolvePause } from "@/lib/engine";
import { getAgentDefinition } from "@/lib/agents";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const task = await db.task.findUnique({
    where: { id },
    include: {
      mission: { select: { id: true, title: true, goal: true } },
      events: { orderBy: { createdAt: "asc" } },
      documents: {
        orderBy: { updatedAt: "desc" },
        select: { id: true, title: true, updatedAt: true, authorRole: true, kind: true },
      },
    },
  });
  if (!task) return Response.json({ error: "not_found" }, { status: 404 });

  const ids = depIds(task.dependsOn);
  const predecessorRows = ids.length
    ? await db.task.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, column: true, role: true },
      })
    : [];
  const predecessorById = new Map(predecessorRows.map((predecessor) => [predecessor.id, predecessor]));
  const predecessors = ids.flatMap((predecessorId) => {
    const predecessor = predecessorById.get(predecessorId);
    return predecessor ? [predecessor] : [];
  });

  const agentInstructions = task.agentPrompt
    ? task.agentPrompt
    : await getAgentDefinition(task.role)
        .then((agent) => agent?.instructions ?? null)
        .catch(() => null);

  return Response.json({ ...task, predecessors, agentInstructions });
}

function depIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
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
      if (body.action === "answer" && !body.content?.trim()) {
        return Response.json({ error: "answer content required" }, { status: 400 });
      }
      const result = await resolvePause(
        id,
        body.action === "approve"
          ? { kind: "approve", allow: body.allow !== false, reason: body.reason }
          : { kind: "answer", content: body.content!.trim() }
      );
      return Response.json(result, { status: result.ok ? 200 : 409 });
    }
    default:
      return Response.json({ error: "unknown action" }, { status: 400 });
  }
}
