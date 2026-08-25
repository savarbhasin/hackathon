export interface TaskDependencyNode {
  id: string;
  dependsOn: string[];
}

export function dependencyIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function findDependencyCycle(nodes: TaskDependencyNode[]): string[] | null {
  const graph = new Map(nodes.map((node) => [node.id, node.dependsOn]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const path: string[] = [];

  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      const cycleStart = path.indexOf(id);
      return [...path.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    path.push(id);
    for (const dependencyId of graph.get(id) ?? []) {
      if (!graph.has(dependencyId)) continue;
      const cycle = visit(dependencyId);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}
