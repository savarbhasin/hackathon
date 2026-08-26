import { db } from "@/lib/db";
import { getAgentDefinition } from "@/lib/agents";

export async function getTaskDetail(id: string) {
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
  if (!task) return null;

  const ids = depIds(task.dependsOn);
  const rows = ids.length ? await db.task.findMany({
    where: { id: { in: ids } },
    select: { id: true, title: true, column: true, role: true },
  }) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const predecessors = ids.flatMap((dependencyId) => {
    const row = byId.get(dependencyId);
    return row ? [row] : [];
  });
  const agentInstructions = task.agentPrompt ?? await getAgentDefinition(task.role)
    .then((agent) => agent?.instructions ?? null)
    .catch(() => null);
  return { ...task, predecessors, agentInstructions };
}

function depIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}
