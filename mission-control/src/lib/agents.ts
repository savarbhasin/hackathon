import { db } from "./db";
import { ROLES } from "./fleet";

export interface AgentDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  isDefault: boolean;
  enabled: boolean;
  updatedAt: Date | null;
}

export function agentSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function listAgentDefinitions(): Promise<AgentDefinition[]> {
  const stored = await db.agentProfile.findMany({ orderBy: { updatedAt: "desc" } });
  const overrides = new Map(stored.map((agent) => [agent.slug, agent]));
  const defaults = Object.values(ROLES).map((role) => {
    const override = overrides.get(role.id);
    overrides.delete(role.id);
    return {
      id: override?.id ?? `preset:${role.id}`,
      slug: role.id,
      name: override?.name ?? role.label,
      description: override?.description ?? role.description,
      instructions: override?.instructions ?? role.instructions,
      isDefault: true,
      enabled: override?.enabled ?? true,
      updatedAt: override?.updatedAt ?? null,
    };
  });

  const custom = [...overrides.values()].map((agent) => ({
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    isDefault: false,
    enabled: agent.enabled,
    updatedAt: agent.updatedAt,
  }));
  return [...defaults, ...custom];
}

export async function getAgentDefinition(slug: string): Promise<AgentDefinition | null> {
  const normalized = agentSlug(slug);
  if (!normalized) return null;
  const stored = await db.agentProfile.findUnique({ where: { slug: normalized } });
  if (stored) {
    return {
      id: stored.id,
      slug: stored.slug,
      name: stored.name,
      description: stored.description,
      instructions: stored.instructions,
      isDefault: stored.isDefault || Boolean(ROLES[stored.slug]),
      enabled: stored.enabled,
      updatedAt: stored.updatedAt,
    };
  }
  const role = ROLES[normalized];
  if (!role) return null;
  return {
    id: `preset:${role.id}`,
    slug: role.id,
    name: role.label,
    description: role.description,
    instructions: role.instructions,
    isDefault: true,
    enabled: true,
    updatedAt: null,
  };
}
