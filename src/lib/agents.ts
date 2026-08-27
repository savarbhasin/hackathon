import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TrueForgeError } from "@truefoundry/trueforge-sdk";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { convexUrl } from "./queue/env";
import {
  MCP_SERVER_NAME,
  ROLES,
  routingDescription,
  stripSpecialistRuntimeInstructions,
  withSpecialistRuntimeInstructions,
} from "./fleet";
import { tf } from "./tf";

const REQUIRED_MISSION_CONTROL_TOOLS = ["mark_done", "create_doc", "update_doc", "get_doc"] as const;
const DEFAULT_MODEL = ROLES.writer.spec.model.name;

let convexClient: ConvexHttpClient | undefined;
function convex(): ConvexHttpClient {
  return convexClient ??= new ConvexHttpClient(convexUrl(), { logger: false });
}

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

interface RosterEntry {
  slug: string;
  name: string;
  description: string;
  mcpServers: TrueForgeApi.McpServer[];
  sandboxEnabled: boolean;
  subagentsEnabled: boolean;
}

const ROSTER_HEADER = `## Available agents
This roster is the complete set of specialist agents you may assign. Use each id exactly as the role value in create_task. Never invent an agent name or assume a connector exists.`;

export async function agentRosterBlock(): Promise<string> {
  let entries: RosterEntry[];
  try {
    entries = (await listAgentDefinitions())
      .filter((agent) => agent.enabled)
      .map(({ slug, name, description, mcpServers, sandboxEnabled, subagentsEnabled }) => ({
        slug,
        name,
        description,
        mcpServers,
        sandboxEnabled,
        subagentsEnabled,
      }));
  } catch (err) {
    console.error("Live agent catalog unavailable; falling back to preset roles", err);
    entries = await presetRosterEntries();
  }

  const header = entries.length > 0
    ? ROSTER_HEADER
    : `${ROSTER_HEADER}\nNo agents are currently enabled. Do not call create_task or dispatch_ready; report to the user that no specialist agents are available.`;

  if (entries.length === 0) return header;

  const lines = entries.map((entry) => {
    const connectors = entry.mcpServers.map(describeMcpServer).join("; ");
    const capabilities = [
      entry.sandboxEnabled ? "sandbox" : null,
      entry.subagentsEnabled ? "subagents" : null,
    ].filter(Boolean).join(", ");
    const description = rosterText(entry.description).replace(/\.+$/, "");
    let line = `- ${rosterText(entry.slug, 64)} (${rosterText(entry.name, 120)}): ${description}. Connectors: ${connectors || "mission-control completion tools only"}`;
    if (capabilities) line += `. Capabilities: ${capabilities}`;
    return line;
  });
  return `${header}\n${lines.join("\n")}`;
}

async function presetRosterEntries(): Promise<RosterEntry[]> {
  let disabledSlugs = new Set<string>();
  try {
    const profiles = await convex().query(api.agentProfiles.list, { limit: 2000 });
    disabledSlugs = new Set(
      profiles
        .filter((profile: AgentProfileMetadata) => !profile.enabled)
        .map((profile: AgentProfileMetadata) => profile.slug)
    );
  } catch {
    // Convex metadata unavailable too; advertise nothing rather than guessing.
    return [];
  }
  return Object.values(ROLES)
    .filter((role) => !disabledSlugs.has(role.id))
    .map((role) => ({
      slug: role.id,
      name: role.label,
      description: role.description,
      mcpServers: role.spec.mcpServers ?? [],
      sandboxEnabled: role.spec.config?.sandbox?.enabled ?? false,
      subagentsEnabled: role.spec.config?.dynamicSubAgents?.enabled ?? false,
    }));
}

// Agent metadata is mutable user input; flatten it so a crafted description
// cannot forge roster lines or inject directives into the instructions.
function rosterText(value: string, max = 240): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}

function describeMcpServer(server: TrueForgeApi.McpServer): string {
  const enabled = server.enableTools ?? [];
  const disabled = server.disableTools ?? [];
  const approval = server.requireApprovalForTools ?? [];
  let summary = enabled.includes("@all") || enabled.length === 0
    ? "all tools"
    : rosterText(enabled.join(", "), 400);
  if (disabled.includes("@all")) {
    summary = "no tools";
  } else if (disabled.length > 0) {
    summary = `${summary} (excluding ${rosterText(disabled.join(", "), 200)})`;
  }
  const name = rosterText(server.name, 64);
  return approval.length > 0
    ? `${name}: ${summary} (approval required: ${rosterText(approval.join(", "), 200)})`
    : `${name}: ${summary}`;
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
  const { data: remoteAgents } = await tf().agents.list();
  const metadata = await convex().query(api.agentProfiles.list, { limit: 2000 });
  const metadataBySlug = new Map(
    metadata.map((agent: AgentProfileMetadata) => [agent.slug, agent])
  );

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
  const description = requiredText(input.description, "Description");
  const slug = agentSlug(input.slug?.trim() || displayName);
  if (!slug) throw new AgentInputError("Name must contain at least one letter or number.");

  const manifest = buildManifest(input);
  validateMissionControlTools(manifest.mcpServers ?? []);
  const { data: remote } = await tf().agents.create({ name: slug, manifest });
  try {
    const metadata = await convex().mutation(api.agentProfiles.upsert, {
      slug,
      name: displayName,
      description,
      instructions: "",
      enabled: input.enabled ?? true,
      isDefault: false,
    });
    return toDefinition(remote, requireProfileMetadata(metadata));
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

  const currentMetadata = await convex().query(api.agentProfiles.getBySlug, { slug: remote.name });
  const role = ROLES[remote.name];
  const manifest = buildManifest(input, remote.manifest);
  validateMissionControlTools(manifest.mcpServers ?? []);
  const { data: updated } = await tf().agents.update(remote.id, { manifest });

  const displayName = optionalText(input.name, 64) ?? currentMetadata?.name ?? role?.label ?? humanize(remote.name);
  const description =
    optionalText(input.description) ??
    currentMetadata?.description ??
    role?.description ??
    "Reusable TrueForge specialist agent.";
  const metadata = await convex().mutation(api.agentProfiles.upsert, {
    slug: remote.name,
    name: displayName,
    description,
    instructions: "",
    enabled: input.enabled ?? currentMetadata?.enabled ?? true,
    isDefault: Boolean(role),
  });
  return toDefinition(updated, requireProfileMetadata(metadata));
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

function buildManifest(
  input: AgentWriteInput,
  current?: TrueForgeApi.AgentSpec
): TrueForgeApi.AgentSpec {
  const currentEditableInstructions = stripStoredRuntimeInstructions(current?.instructions ?? "");
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
  const subagentsEnabled = input.subagentsEnabled ?? current?.config?.dynamicSubAgents?.enabled ?? false;

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
      // Dynamic subagents are opt-in per specialist. The runtime prompt still
      // requires an explicit assignment before creating one.
      dynamicSubAgents: { enabled: subagentsEnabled },
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

function defaultMissionControlServer(): TrueForgeApi.McpServer[] {
  return [{ name: MCP_SERVER_NAME, enableTools: [...REQUIRED_MISSION_CONTROL_TOOLS] }];
}

async function resolveRemoteAgent(id: string): Promise<TrueForgeApi.Agent> {
  return (await tf().agents.get(id)).data;
}

type AgentProfileMetadata = {
  slug: string;
  name: string;
  description: string;
  enabled: boolean;
  updatedAt: number;
};

function requireProfileMetadata(value: unknown): AgentProfileMetadata {
  if (!value || typeof value !== "object" || typeof (value as AgentProfileMetadata).name !== "string") {
    const result = value as { reason?: string } | null;
    throw new AgentInputError(result?.reason ?? "Could not save the agent profile.");
  }
  return value as AgentProfileMetadata;
}

function toDefinition(
  agent: TrueForgeApi.Agent,
  metadata?: AgentProfileMetadata
): AgentDefinition {
  const role = ROLES[agent.name];
  const embeddedDescription = routingDescription(agent.manifest.instructions ?? "");
  return {
    id: agent.id,
    slug: agent.name,
    name: metadata?.name ?? role?.label ?? humanize(agent.name),
    description:
      metadata?.description || embeddedDescription || role?.description || "Reusable TrueForge specialist agent.",
    instructions: stripStoredRuntimeInstructions(agent.manifest.instructions ?? ""),
    isDefault: Boolean(role),
    enabled: metadata?.enabled ?? true,
    updatedAt: metadata?.updatedAt ? new Date(metadata.updatedAt) : null,
    model: agent.manifest.model.name,
    mcpServers: agent.manifest.mcpServers ?? [],
    sandboxEnabled: agent.manifest.config?.sandbox?.enabled ?? false,
    subagentsEnabled: agent.manifest.config?.dynamicSubAgents?.enabled ?? false,
  };
}

function stripStoredRuntimeInstructions(storedInstructions: string): string {
  return stripSpecialistRuntimeInstructions(storedInstructions);
}

function requiredText(value: string | undefined, field: string, max?: number): string {
  const clean = optionalText(value, max);
  if (!clean) throw new AgentInputError(`${field} is required.`);
  return clean;
}

function optionalText(value: unknown, max?: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = value.trim();
  return clean ? (max === undefined ? clean : clean.slice(0, max)) : undefined;
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
