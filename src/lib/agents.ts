import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeError } from "@truefoundry/trueforge-sdk";
import { db } from "./db";
import {
  MCP_SERVER_NAME,
  ROLES,
  stripSpecialistRuntimeInstructions,
  withSpecialistRuntimeInstructions,
} from "./fleet";
import { tf } from "./tf";

const REQUIRED_MISSION_CONTROL_TOOLS = ["mark_done", "create_doc", "update_doc", "get_doc"] as const;
const DEFAULT_MODEL = ROLES.writer.spec.model.name;

export interface AgentDefinition {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  isDefault: boolean;
  enabled: boolean;
  updatedAt: Date | null;
  model: string;
  mcpServers: TrueForgeApi.McpServer[];
  sandboxEnabled: boolean;
  subagentsEnabled: boolean;
}

export interface AgentWriteInput {
  slug?: string;
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
  model?: string;
  mcpServers?: unknown;
  sandboxEnabled?: boolean;
  subagentsEnabled?: boolean;
}

export interface AgentCatalog {
  agents: AgentDefinition[];
  connectors: Array<{
    name: string;
    url?: string;
    tools: Array<{ name: string; description?: string }>;
  }>;
  models: Array<{ name: string }>;
  capabilities: { sandbox: boolean };
}

export class AgentInputError extends Error {}

export function agentSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export async function listAgentDefinitions(): Promise<AgentDefinition[]> {
  const remoteAgents = await listAndSeedAgents();
  const metadata = await db.agentProfile.findMany();
  const metadataBySlug = new Map(metadata.map((agent) => [agent.slug, agent]));

  return remoteAgents
    .map((agent) => toDefinition(agent, metadataBySlug.get(agent.name)))
    .sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

export async function getAgentDefinition(slug: string): Promise<AgentDefinition | null> {
  const agents = await listAgentDefinitions();
  const exact = agents.find((agent) => agent.slug === slug);
  if (exact) return exact;
  const normalized = agentSlug(slug);
  return agents.find((agent) => agent.slug === normalized) ?? null;
}

export async function getAgentCatalog(): Promise<AgentCatalog> {
  const [agents, connectorResponse, modelResponse, capabilityResponse] = await Promise.all([
    listAgentDefinitions(),
    tf().mcpServers.list(),
    tf().models.list(),
    tf().server.getCapabilities(),
  ]);

  const connectors = await Promise.all(
    connectorResponse.data.map(async (connector) => {
      let tools: Array<{ name: string; description?: string }> = [];
      try {
        const response = await tf().mcpServers.listTools(connector.name);
        tools = response.data.flatMap((tool) => {
          const name = typeof tool.name === "string" ? tool.name : "";
          if (!name) return [];
          return [{
            name,
            ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          }];
        });
      } catch {
        // An unauthorised connector should not make the whole agent library unusable.
      }
      return {
        name: connector.name,
        ...(connector.url ? { url: connector.url } : {}),
        tools,
      };
    })
  );

  return {
    agents,
    connectors,
    models: modelResponse.data.map((model) => ({ name: model.name })),
    capabilities: { sandbox: capabilityResponse.data.sandbox.enabled },
  };
}

export async function createAgentDefinition(input: AgentWriteInput): Promise<AgentDefinition> {
  const displayName = requiredText(input.name, "Name", 64);
  const description = requiredText(input.description, "Description", 240);
  const slug = agentSlug(input.slug?.trim() || displayName);
  if (!slug) throw new AgentInputError("Name must contain at least one letter or number.");

  const manifest = buildManifest(input);
  validateMissionControlTools(manifest.mcpServers ?? []);
  const { data: remote } = await tf().agents.create({ name: slug, manifest });
  try {
    const metadata = await db.agentProfile.upsert({
      where: { slug },
      create: {
        slug,
        name: displayName,
        description,
        instructions: "",
        enabled: input.enabled ?? true,
        isDefault: false,
      },
      update: {
        name: displayName,
        description,
        instructions: "",
        enabled: input.enabled ?? true,
      },
    });
    return toDefinition(remote, metadata);
  } catch (error) {
    await tf().agents.delete(remote.id).catch(() => undefined);
    throw error;
  }
}

export async function updateAgentDefinition(
  id: string,
  input: AgentWriteInput
): Promise<AgentDefinition> {
  const remote = await resolveRemoteAgent(id);
  if (input.slug && input.slug !== remote.name) {
    throw new AgentInputError("The TrueForge agent name is immutable. Create a new agent to use another role id.");
  }

  const currentMetadata = await db.agentProfile.findUnique({ where: { slug: remote.name } });
  const role = ROLES[remote.name];
  const manifest = buildManifest(input, remote.manifest, Boolean(role || currentMetadata));
  validateMissionControlTools(manifest.mcpServers ?? []);
  const { data: updated } = await tf().agents.update(remote.id, { manifest });

  const displayName = optionalText(input.name, 64) ?? currentMetadata?.name ?? role?.label ?? humanize(remote.name);
  const description =
    optionalText(input.description, 240) ??
    currentMetadata?.description ??
    role?.description ??
    "Reusable TrueForge specialist agent.";
  const metadata = await db.agentProfile.upsert({
    where: { slug: remote.name },
    create: {
      slug: remote.name,
      name: displayName,
      description,
      instructions: "",
      enabled: input.enabled ?? true,
      isDefault: Boolean(role),
    },
    update: {
      name: displayName,
      description,
      instructions: "",
      enabled: input.enabled ?? currentMetadata?.enabled ?? true,
      isDefault: Boolean(role),
    },
  });
  return toDefinition(updated, metadata);
}

export function registryError(error: unknown): { status: number; message: string } {
  if (error instanceof AgentInputError) return { status: 400, message: error.message };
  if (error instanceof TrueForgeError) {
    const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
      ? error.statusCode
      : 503;
    return { status, message: trueForgeMessage(error) };
  }
  return {
    status: 503,
    message: error instanceof Error ? error.message : "TrueForge agent registry is unavailable.",
  };
}

async function listAndSeedAgents(): Promise<TrueForgeApi.Agent[]> {
  let { data: agents } = await tf().agents.list();
  const managedSlugs = new Set(
    (await db.agentProfile.findMany({ select: { slug: true } })).map((profile) => profile.slug)
  );
  const names = new Set(agents.map((agent) => agent.name));
  const missing = Object.values(ROLES).filter((role) => !names.has(role.id));

  for (const role of missing) {
    try {
      const { data: created } = await tf().agents.create({
        name: role.id,
        manifest: presetManifest(role),
      });
      agents = [...agents, created];
      names.add(created.name);
    } catch (error) {
      // Next and the MCP server can seed at the same time. Only ignore a real race.
      const refreshed = await tf().agents.list();
      const createdByPeer = refreshed.data.find((agent) => agent.name === role.id);
      if (!createdByPeer) throw error;
      agents = refreshed.data;
      names.clear();
      for (const agent of agents) names.add(agent.name);
    }
  }

  for (const agent of agents) {
    const role = ROLES[agent.name];
    if (!role && !managedSlugs.has(agent.name)) continue;

    const editableInstructions = stripStoredRuntimeInstructions(
      agent.manifest.instructions ?? "",
      true
    ).trim();
    const instructions = withSpecialistRuntimeInstructions(
      editableInstructions || role?.instructions || "Complete the assigned specialist task within its stated scope."
    );
    const model = role?.spec.model ?? agent.manifest.model;
    if (
      agent.manifest.model.name === model.name &&
      agent.manifest.instructions === instructions
    ) continue;

    const { data: updated } = await tf().agents.update(agent.id, {
      manifest: {
        ...agent.manifest,
        model,
        instructions,
      },
    });
    agents = agents.map((current) => current.id === updated.id ? updated : current);
  }

  return agents;
}

function presetManifest(role: (typeof ROLES)[string]): TrueForgeApi.AgentSpec {
  return {
    ...role.spec,
    mcpServers: withRequiredMissionControlTools(role.spec.mcpServers ?? []),
  };
}

function buildManifest(
  input: AgentWriteInput,
  current?: TrueForgeApi.AgentSpec,
  managedByMissionControl = false
): TrueForgeApi.AgentSpec {
  const currentEditableInstructions = stripStoredRuntimeInstructions(
    current?.instructions ?? "",
    managedByMissionControl
  );
  const editableInstructions = input.instructions === undefined
    ? currentEditableInstructions.trim()
    : optionalText(input.instructions, 12000) ?? "";
  if (editableInstructions.length < 40) {
    throw new AgentInputError("System instructions must contain at least 40 characters.");
  }
  const instructions = withSpecialistRuntimeInstructions(editableInstructions);

  const modelName = optionalText(input.model, 200) ?? current?.model.name ?? DEFAULT_MODEL;
  const mcpServers = input.mcpServers === undefined
    ? current?.mcpServers ?? defaultMissionControlServer()
    : parseMcpServers(input.mcpServers);
  const sandboxEnabled = input.sandboxEnabled ?? current?.config?.sandbox?.enabled ?? false;
  const subagentsEnabled =
    input.subagentsEnabled ?? current?.config?.dynamicSubAgents?.enabled ?? true;

  return {
    ...current,
    model: current?.model.name === modelName ? current.model : { name: modelName },
    instructions,
    mcpServers,
    config: {
      ...current?.config,
      sandbox: {
        ...current?.config?.sandbox,
        enabled: sandboxEnabled,
      },
      dynamicSubAgents: {
        ...current?.config?.dynamicSubAgents,
        enabled: subagentsEnabled,
      },
    },
  };
}

function parseMcpServers(value: unknown): TrueForgeApi.McpServer[] {
  if (!Array.isArray(value)) throw new AgentInputError("mcpServers must be an array.");
  const seen = new Set<string>();
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object") {
      throw new AgentInputError(`mcpServers[${index}] must be an object.`);
    }
    const input = raw as Record<string, unknown>;
    const name = optionalText(input.name, 120);
    if (!name) throw new AgentInputError(`mcpServers[${index}].name is required.`);
    if (seen.has(name)) throw new AgentInputError(`Connector "${name}" appears more than once.`);
    seen.add(name);

    return {
      name,
      ...optionalStringList(input.enableTools, `mcpServers[${index}].enableTools`),
      ...optionalStringList(input.disableTools, `mcpServers[${index}].disableTools`),
      ...optionalStringList(input.preloadTools, `mcpServers[${index}].preloadTools`),
      ...optionalStringList(
        input.requireApprovalForTools,
        `mcpServers[${index}].requireApprovalForTools`
      ),
      ...(typeof input.preload === "boolean" ? { preload: input.preload } : {}),
    } as TrueForgeApi.McpServer;
  });
}

function optionalStringList(value: unknown, field: string): Record<string, string[]> {
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new AgentInputError(`${field} must be an array of tool names.`);
  }
  const key = field.slice(field.lastIndexOf(".") + 1);
  return { [key]: [...new Set(value)] };
}

function validateMissionControlTools(mcpServers: TrueForgeApi.McpServer[]) {
  const server = mcpServers.find((entry) => entry.name === MCP_SERVER_NAME);
  if (!server) {
    throw new AgentInputError(`Every agent must include the "${MCP_SERVER_NAME}" connector.`);
  }
  const enabledSet = new Set(server.enableTools ?? ["@all"]);
  const missing = REQUIRED_MISSION_CONTROL_TOOLS.filter(
    (tool) => !enabledSet.has("@all") && !enabledSet.has(tool)
  );
  const disabled = new Set(server.disableTools ?? []);
  const disablesRequired =
    disabled.has("@all") ||
    disabled.has("@read-only") ||
    REQUIRED_MISSION_CONTROL_TOOLS.some((tool) => disabled.has(tool));
  if (missing.length > 0 || disablesRequired) {
    throw new AgentInputError(
      `The "${MCP_SERVER_NAME}" connector must keep ${REQUIRED_MISSION_CONTROL_TOOLS.join(", ")} enabled.`
    );
  }
}

function withRequiredMissionControlTools(
  servers: TrueForgeApi.McpServer[]
): TrueForgeApi.McpServer[] {
  const existing = servers.find((server) => server.name === MCP_SERVER_NAME);
  if (!existing) return [...servers, ...defaultMissionControlServer()];
  const enabled = new Set(existing.enableTools ?? []);
  for (const tool of REQUIRED_MISSION_CONTROL_TOOLS) enabled.add(tool);
  return servers.map((server) =>
    server.name === MCP_SERVER_NAME ? { ...server, enableTools: [...enabled] } : server
  );
}

function defaultMissionControlServer(): TrueForgeApi.McpServer[] {
  return [{ name: MCP_SERVER_NAME, enableTools: [...REQUIRED_MISSION_CONTROL_TOOLS] }];
}

async function resolveRemoteAgent(id: string): Promise<TrueForgeApi.Agent> {
  return (await tf().agents.get(id)).data;
}

function toDefinition(
  agent: TrueForgeApi.Agent,
  metadata?: {
    name: string;
    description: string;
    enabled: boolean;
    updatedAt: Date;
  }
): AgentDefinition {
  const role = ROLES[agent.name];
  const managedByMissionControl = Boolean(role || metadata);
  return {
    id: agent.id,
    slug: agent.name,
    name: metadata?.name ?? role?.label ?? humanize(agent.name),
    description:
      metadata?.description ?? role?.description ?? "Reusable TrueForge specialist agent.",
    instructions: stripStoredRuntimeInstructions(
      agent.manifest.instructions ?? "",
      managedByMissionControl
    ),
    isDefault: Boolean(role),
    enabled: metadata?.enabled ?? true,
    updatedAt: metadata?.updatedAt ?? null,
    model: agent.manifest.model.name,
    mcpServers: agent.manifest.mcpServers ?? [],
    sandboxEnabled: agent.manifest.config?.sandbox?.enabled ?? false,
    subagentsEnabled: agent.manifest.config?.dynamicSubAgents?.enabled ?? true,
  };
}

function stripStoredRuntimeInstructions(
  storedInstructions: string,
  managedByMissionControl: boolean
): string {
  const current = stripSpecialistRuntimeInstructions(storedInstructions);
  if (current !== storedInstructions || !managedByMissionControl) return current;

  const runtimeMarker = "You are a specialist agent in a fleet managed by Mission Control.\n";
  if (!storedInstructions.startsWith(runtimeMarker)) return storedInstructions;
  const boundary = storedInstructions.indexOf("\n\n");
  return boundary === -1 ? storedInstructions : storedInstructions.slice(boundary + 2);
}

function requiredText(value: string | undefined, field: string, max: number): string {
  const clean = optionalText(value, max);
  if (!clean) throw new AgentInputError(`${field} is required.`);
  return clean;
}

function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : undefined;
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function trueForgeMessage(error: TrueForgeError): string {
  if (error.body && typeof error.body === "object") {
    const body = error.body as Record<string, unknown>;
    const detail = body.detail ?? body.message ?? body.error;
    if (typeof detail === "string" && detail.trim()) return detail;
  }
  if (error.statusCode === 409) return "A TrueForge agent with that role id already exists.";
  if (error.statusCode === 404) return "TrueForge agent not found.";
  return error.message || "TrueForge agent registry is unavailable.";
}
