"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface ToolOption { name: string; description?: string }
interface ConnectorOption { name: string; url?: string; tools: ToolOption[] }
interface ModelOption { name: string }
interface AgentCapabilities { sandbox: boolean }
interface McpServerConfig {
  name: string;
  enableTools?: string[];
  disableTools?: string[];
  preloadTools?: string[];
  preload?: boolean;
  requireApprovalForTools?: string[];
}
interface AgentProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  isDefault: boolean;
  enabled: boolean;
  updatedAt: string | null;
  model: string;
  mcpServers: McpServerConfig[];
  sandboxEnabled: boolean;
  subagentsEnabled: boolean;
}
interface AgentCatalog {
  agents: AgentProfile[];
  connectors: ConnectorOption[];
  models: ModelOption[];
  capabilities: AgentCapabilities;
}
interface DraftAgent extends Omit<AgentProfile, "id" | "updatedAt"> { id: string | null }

const CHEAP_MODEL = "openai/gpt-5-4-mini";
const CORE_CONNECTOR = "mission-control";
const CORE_TOOLS = ["mark_done", "create_doc", "update_doc", "get_doc"];
const EMPTY_CATALOG: AgentCatalog = { agents: [], connectors: [], models: [], capabilities: { sandbox: false } };

export default function AgentsPage() {
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY_CATALOG);
  const [draft, setDraft] = useState<DraftAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async (preferredId?: string) => {
    const response = await fetch("/api/agents", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load agents.");
    const next = normalizeCatalog(await response.json());
    setCatalog(next);
    setDraft((current) => {
      if (current?.id === null && !preferredId) return current;
      const selected = next.agents.find((agent) => agent.id === preferredId)
        ?? next.agents.find((agent) => agent.slug === current?.slug)
        ?? next.agents[0];
      return selected ? toDraft(selected) : newDraft(next);
    });
  }, []);

  useEffect(() => {
    void fetch("/api/agents", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load agents.");
        return normalizeCatalog(await response.json());
      })
      .then((next) => {
        setCatalog(next);
        setDraft(next.agents[0] ? toDraft(next.agents[0]) : newDraft(next));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const dirty = useMemo(() => {
    if (!draft) return false;
    if (draft.id === null) return hasNewAgentContent(draft);
    const source = catalog.agents.find((agent) => agent.id === draft.id);
    return source ? comparableAgent(source) !== comparableAgent(draft) : true;
  }, [catalog.agents, draft]);
  const valid = Boolean(draft?.name.trim() && draft.slug.trim() && draft.description.trim()
    && draft.instructions.trim().length >= 40 && draft.model);

  function updateDraft(next: Partial<DraftAgent>) {
    setDraft((current) => current ? { ...current, ...next } : current);
  }

  function selectAgent(agent: AgentProfile) {
    if (saving) return;
    setError(null);
    setDraft(toDraft(agent));
  }

  function updateName(name: string) {
    setDraft((current) => {
      if (!current || current.id) return current;
      const oldPreview = slugPreview(current.name);
      return { ...current, name, slug: !current.slug || current.slug === oldPreview ? slugPreview(name) : current.slug };
    });
  }

  function setConnectorEnabled(connector: ConnectorOption, enabled: boolean) {
    if (!draft || connector.name === CORE_CONNECTOR) return;
    const rest = draft.mcpServers.filter((server) => server.name !== connector.name);
    updateDraft({ mcpServers: enabled ? [...rest, {
      name: connector.name,
      enableTools: connector.tools.map((tool) => tool.name),
      requireApprovalForTools: [],
    }] : rest });
  }

  function replaceServer(next: McpServerConfig) {
    if (!draft) return;
    updateDraft({ mcpServers: draft.mcpServers.map((server) => server.name === next.name ? next : server) });
  }

  function setToolEnabled(connector: ConnectorOption, toolName: string, enabled: boolean) {
    if (!draft || isCoreTool(connector.name, toolName)) return;
    const server = draft.mcpServers.find((item) => item.name === connector.name);
    if (!server) return;
    const current = selectedToolNames(server, connector);
    const enableTools = enabled ? unique([...current, toolName]) : current.filter((name) => name !== toolName);
    replaceServer({
      ...server,
      enableTools,
      disableTools: (server.disableTools ?? []).filter((name) => name !== toolName && name !== "@all"),
      requireApprovalForTools: (server.requireApprovalForTools ?? []).filter((name) => enableTools.includes(name)),
    });
  }

  function setToolApproval(connector: ConnectorOption, toolName: string, required: boolean) {
    if (!draft || isCoreTool(connector.name, toolName)) return;
    const server = draft.mcpServers.find((item) => item.name === connector.name);
    if (!server) return;
    const current = server.requireApprovalForTools ?? [];
    replaceServer({ ...server, requireApprovalForTools: required
      ? unique([...current, toolName])
      : current.filter((name) => name !== toolName) });
  }

  async function save() {
    if (!draft || saving || !valid) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(draft.id ? `/api/agents/${encodeURIComponent(draft.id)}` : "/api/agents", {
        method: draft.id ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...draft,
          name: draft.name.trim(),
          slug: draft.slug.trim(),
          description: draft.description.trim(),
          instructions: draft.instructions.trim(),
          mcpServers: withRequiredCoreTools(draft.mcpServers),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as AgentProfile | { agent?: AgentProfile; error?: string };
      if (!response.ok) throw new Error("error" in body ? body.error ?? "Could not save agent." : "Could not save agent.");
      const savedId = "agent" in body
        ? body.agent?.id
        : "id" in body && typeof body.id === "string" ? body.id : undefined;
      await loadAgents(savedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  const agents = catalog.agents;
  const connectors = connectorCatalog(catalog.connectors);

  return (
    <main className="flex h-full min-w-0 flex-col bg-deck">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-deck px-5 sm:px-6">
        <div>
          <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">Agent library</p>
          <h1 className="mt-0.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">Specialists</h1>
        </div>
        <p className="hidden max-w-md text-xs leading-relaxed text-ink-faint md:block">
          Choose the model and tools each specialist receives when a task starts.
        </p>
        <button type="button" onClick={() => { setError(null); setDraft(newDraft(catalog)); }}
          className="ml-auto rounded-md bg-signal px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:brightness-110">
          New agent
        </button>
      </header>

      {loading ? <p className="p-6 font-mono text-xs text-ink-faint">Loading agents...</p> : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_290px]">
          <aside className="scrollbar-none order-1 max-h-52 overflow-y-auto border-b border-line bg-panel/55 p-3 md:order-2 md:max-h-none md:border-b-0 md:border-l">
            <p className="px-2 pb-2 font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">
              {agents.filter((agent) => agent.enabled).length} active
            </p>
            <div className="space-y-1.5">
              {agents.map((agent) => (
                <button key={agent.id} type="button" onClick={() => selectAgent(agent)}
                  className={`block w-full rounded-md border px-3 py-3 text-left transition-colors ${draft?.id === agent.id
                    ? "border-line-strong bg-panel-hi text-ink"
                    : "border-transparent text-ink-soft hover:border-line hover:bg-panel-hi/70 hover:text-ink"}`}>
                  <span className="flex items-center gap-2">
                    <span className="truncate text-xs font-semibold">{agent.name}</span>
                    {!agent.enabled && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" aria-label="Disabled" />}
                  </span>
                  <span className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-ink-faint">{agent.description}</span>
                  <span className="mt-2 flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
                    <span>{agent.isDefault ? "Default" : "Custom"}</span><span>/</span><span className="truncate">{shortModelName(agent.model)}</span>
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <section className="console-grid order-2 min-h-0 overflow-y-auto px-5 py-6 sm:px-8 md:order-1 lg:px-12">
            {draft && <div className="mx-auto max-w-5xl">
              <div className="mb-7 flex flex-wrap items-start justify-between gap-5">
                <div>
                  <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-role-writer">
                    {draft.id ? draft.isDefault ? "Default agent" : "Custom agent" : "New custom agent"}
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-ink">
                    {draft.id ? draft.name : "Build a reusable specialist"}
                  </h2>
                </div>
                <label className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-panel/70 px-3 py-2 text-xs text-ink-soft">
                  <input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft({ enabled: event.target.checked })}
                    className="accent-[var(--color-signal)]" />
                  Available to Squad Lead
                </label>
              </div>

              <EditorSection eyebrow="Identity" title="How the Squad Lead sees this agent"
                description="Names and role IDs stay fixed after creation so existing task references remain valid.">
                <div className="grid gap-5 sm:grid-cols-2">
                  <FieldLabel label="Name">
                    <input value={draft.name} onChange={(event) => updateName(event.target.value)} readOnly={Boolean(draft.id)}
                      maxLength={64} placeholder="Release manager" className={inputClass(Boolean(draft.id))} />
                  </FieldLabel>
                  <FieldLabel label="Role id">
                    <input value={draft.slug} onChange={(event) => updateDraft({ slug: slugPreview(event.target.value) })}
                      readOnly={Boolean(draft.id)} maxLength={48} placeholder="release-manager"
                      className={`${inputClass(Boolean(draft.id))} font-mono text-xs`} />
                  </FieldLabel>
                </div>
                <FieldLabel label="What this agent is for" className="mt-5">
                  <input value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })}
                    maxLength={240} placeholder="One sentence the Squad Lead can use when choosing an agent."
                    className={inputClass(false)} />
                </FieldLabel>
              </EditorSection>

              <EditorSection eyebrow="Runtime" title="Model and agent capabilities"
                description="Use the lightest model that can do the work. Enable sandbox and subagents only when the assignment needs them.">
                <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.8fr)]">
                  <FieldLabel label="Model">
                    <div className="relative">
                      <select value={draft.model} onChange={(event) => updateDraft({ model: event.target.value })}
                        className={`${inputClass(false)} appearance-none pr-10`}>
                        {catalog.models.length === 0 && <option value={draft.model}>{draft.model || "No models configured"}</option>}
                        {catalog.models.map((model) => <option key={model.name} value={model.name}>{model.name}</option>)}
                      </select>
                      <svg viewBox="0 0 12 12" aria-hidden="true" className="pointer-events-none absolute right-3 top-1/2 h-3 w-3 -translate-y-1/2 text-ink-faint">
                        <path d="m2.5 4.25 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </div>
                  </FieldLabel>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
                    <CapabilityToggle label="Sandbox"
                      description={catalog.capabilities.sandbox ? "Files, commands, and code execution" : "Unavailable in TrueForge"}
                      checked={draft.sandboxEnabled} disabled={!catalog.capabilities.sandbox}
                      onChange={(checked) => updateDraft({ sandboxEnabled: checked })} />
                    <CapabilityToggle label="Dynamic subagents" description="Can split work into parallel specialist threads"
                      checked={draft.subagentsEnabled} onChange={(checked) => updateDraft({ subagentsEnabled: checked })} />
                  </div>
                </div>
              </EditorSection>

              <EditorSection eyebrow="Tools" title="Connectors and approval gates"
                description="Select only the connectors this role needs. Approval gates pause the task before the chosen tool runs.">
                <div className="space-y-3">
                  {connectors.map((connector) => {
                    const server = draft.mcpServers.find((item) => item.name === connector.name);
                    const required = connector.name === CORE_CONNECTOR;
                    return <ConnectorEditor key={connector.name} connector={connector} server={server}
                      selected={required || Boolean(server)} required={required}
                      onToggle={(checked) => setConnectorEnabled(connector, checked)}
                      onToolToggle={(tool, checked) => setToolEnabled(connector, tool, checked)}
                      onApprovalToggle={(tool, checked) => setToolApproval(connector, tool, checked)} />;
                  })}
                  {connectors.length === 1 && <p className="rounded-md border border-dashed border-line px-4 py-5 text-xs leading-relaxed text-ink-faint">
                    No external connectors are configured. Add one in TrueForge to make it available here.
                  </p>}
                </div>
              </EditorSection>

              <EditorSection eyebrow="Behavior" title="System instructions"
                description="Define the scope, working method, tool rules, and what a finished result must contain.">
                <textarea value={draft.instructions} onChange={(event) => updateDraft({ instructions: event.target.value })}
                  rows={16} placeholder="Give this agent a narrow job, a concrete workflow, and a clear completion rule."
                  className="scrollbar-none min-h-[320px] w-full resize-y rounded-md border border-line-strong bg-panel p-4 font-mono text-[12px] leading-6 text-ink outline-none placeholder:text-ink-faint focus:border-signal" />
                <p className="mt-2 text-right font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
                  {draft.instructions.trim().length} characters / 40 minimum
                </p>
              </EditorSection>

              {error && <p className="mt-5 rounded-md border border-state-blocked/30 bg-state-blocked/[0.04] px-3 py-2.5 text-xs text-state-blocked">{error}</p>}
              <div className="sticky bottom-3 -mx-3 mt-6 flex items-center gap-3 rounded-lg border border-line-strong bg-deck/95 px-5 py-4 shadow-[0_8px_24px_rgba(0,0,0,0.16)] backdrop-blur-sm sm:-mx-5 sm:px-6">
                <p className="text-[10px] leading-relaxed text-ink-faint">
                  Changes apply to future turns, including resumed paused tasks.
                </p>
                <button type="button" onClick={() => void save()} disabled={!dirty || !valid || saving}
                  className="ml-auto rounded-md bg-ink px-4 py-2.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:bg-white disabled:opacity-30">
                  {saving ? "Saving..." : draft.id ? "Save changes" : "Create agent"}
                </button>
              </div>
            </div>}
          </section>
        </div>
      )}
    </main>
  );
}

function EditorSection({ eyebrow, title, description, children }: {
  eyebrow: string; title: string; description: string; children: React.ReactNode;
}) {
  return <section className="mt-5 rounded-lg border border-line bg-deck/55 p-4 sm:p-5">
    <div className="mb-5 border-b border-line pb-4">
      <p className="font-mono text-[8px] uppercase tracking-[0.18em] text-ink-faint">{eyebrow}</p>
      <h3 className="mt-1.5 text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 max-w-2xl text-[11px] leading-relaxed text-ink-faint">{description}</p>
    </div>
    {children}
  </section>;
}

function FieldLabel({ label, className = "", children }: { label: string; className?: string; children: React.ReactNode }) {
  return <label className={`block ${className}`}>
    <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">{label}</span>{children}
  </label>;
}

function CapabilityToggle({ label, description, checked, disabled = false, onChange }: {
  label: string; description: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void;
}) {
  return <button type="button" aria-pressed={checked} disabled={disabled} onClick={() => onChange(!checked)}
    className={`group flex min-h-24 w-full items-start justify-between gap-4 rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal ${disabled
      ? "cursor-not-allowed border-line bg-deck opacity-55"
      : checked ? "border-signal/70 bg-signal/[0.07]" : "border-line bg-transparent hover:border-line-strong hover:bg-panel/45"}`}>
    <span><span className="block text-xs font-semibold text-ink">{label}</span>
      <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">{description}</span></span>
    <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-1 font-mono text-[8px] uppercase tracking-[0.1em] ${checked
      ? "border-signal/60 bg-signal text-deck" : "border-line text-ink-faint group-hover:text-ink-soft"}`}>
      {checked ? "On" : "Off"}
    </span>
  </button>;
}

function ConnectorEditor({ connector, server, selected, required, onToggle, onToolToggle, onApprovalToggle }: {
  connector: ConnectorOption;
  server?: McpServerConfig;
  selected: boolean;
  required: boolean;
  onToggle: (checked: boolean) => void;
  onToolToggle: (tool: string, checked: boolean) => void;
  onApprovalToggle: (tool: string, checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const enabledTools = server ? selectedToolNames(server, connector) : [];
  const approvals = server?.requireApprovalForTools ?? [];
  const label = connectorLabel(connector.name);
  const toolsId = `connector-tools-${connector.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return <div className={`overflow-hidden rounded-md border ${selected ? "border-line-strong bg-panel/75" : "border-line bg-deck/45"}`}>
    <div className="flex min-h-14 items-stretch">
      <label className={`flex shrink-0 items-center px-4 ${required ? "cursor-not-allowed" : "cursor-pointer"}`}>
        <input type="checkbox" checked={selected} disabled={required} onChange={(event) => onToggle(event.target.checked)}
          aria-label={required ? `${label} access is required` : `${selected ? "Remove" : "Give"} ${label} connector access`}
          className="accent-[var(--color-signal)]" />
      </label>
      <button type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}
        aria-controls={toolsId}
        className="flex min-w-0 flex-1 items-center gap-3 py-3.5 pr-4 text-left transition-colors hover:bg-panel-hi/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-ink">{label}</span>
          <span className="mt-0.5 block font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">
            {required ? "Required for every specialist" : `${connector.tools.length} ${connector.tools.length === 1 ? "tool" : "tools"}`}
          </span>
        </span>
        {required && <span className="rounded border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">Core</span>}
        <svg viewBox="0 0 12 12" aria-hidden="true"
          className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${expanded ? "rotate-90" : ""}`}>
          <path d="m4.25 2.25 3.5 3.75-3.5 3.75" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
    {expanded && <div id={toolsId} className={`border-t border-line ${selected ? "" : "bg-deck/30"}`}>
      {connector.tools.length > 0 ? <>
        <div className="grid grid-cols-[minmax(0,1fr)_70px] gap-3 border-b border-line/70 px-4 py-2 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
          <span>{selected ? "Enabled tools" : "Select connector to enable tools"}</span><span className="text-center">Approval</span>
        </div>
        {connector.tools.map((tool) => {
          const core = isCoreTool(connector.name, tool.name);
          const enabled = selected && (core || enabledTools.includes(tool.name));
          const toolLocked = !selected || core;
          return <div key={tool.name} className={`grid grid-cols-[minmax(0,1fr)_70px] items-center gap-3 border-b border-line/50 px-4 py-3 last:border-b-0 ${selected ? "" : "opacity-50"}`}>
            <label className={`flex items-start gap-3 ${toolLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
              <input type="checkbox" checked={enabled} disabled={toolLocked}
                onChange={(event) => onToolToggle(tool.name, event.target.checked)}
                aria-label={`${enabled ? "Disable" : "Enable"} ${tool.name}`}
                className="mt-0.5 accent-[var(--color-signal)]" />
              <span className="min-w-0"><span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[10px] font-medium text-ink">{tool.name}</span>
                {core && <span className="font-mono text-[7px] uppercase tracking-[0.12em] text-state-settled">Required</span>}
              </span>{tool.description && <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">{tool.description}</span>}</span>
            </label>
            <label className={`flex justify-center ${enabled && !core ? "cursor-pointer" : "cursor-not-allowed opacity-35"}`}
              title={core ? "Mission Control core tools run without an approval gate" : "Pause before this tool runs"}>
              <input type="checkbox" checked={selected && approvals.includes(tool.name)} disabled={!enabled || core}
                onChange={(event) => onApprovalToggle(tool.name, event.target.checked)}
                aria-label={`Require approval for ${tool.name}`} className="accent-[var(--color-state-approval)]" />
            </label>
          </div>;
        })}
      </> : <p className="px-4 py-4 text-[10px] leading-relaxed text-ink-faint">
        This connector did not report any tools.
      </p>}
    </div>}
  </div>;
}

function normalizeCatalog(raw: unknown): AgentCatalog {
  if (Array.isArray(raw)) return { ...EMPTY_CATALOG, agents: raw.map(normalizeAgent) };
  const value = isRecord(raw) ? raw : {};
  return {
    agents: Array.isArray(value.agents) ? value.agents.map(normalizeAgent) : [],
    connectors: Array.isArray(value.connectors) ? value.connectors.map(normalizeConnector).filter(Boolean) as ConnectorOption[] : [],
    models: Array.isArray(value.models) ? value.models.map(normalizeModel).filter(Boolean) as ModelOption[] : [],
    capabilities: { sandbox: isRecord(value.capabilities) && value.capabilities.sandbox === true },
  };
}

function normalizeAgent(raw: unknown): AgentProfile {
  const value = isRecord(raw) ? raw : {};
  return {
    id: stringValue(value.id), slug: stringValue(value.slug), name: stringValue(value.name),
    description: stringValue(value.description), instructions: stringValue(value.instructions),
    isDefault: value.isDefault === true, enabled: value.enabled !== false,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    model: stringValue(value.model),
    mcpServers: Array.isArray(value.mcpServers) ? value.mcpServers.map(normalizeServer).filter(Boolean) as McpServerConfig[] : [],
    sandboxEnabled: value.sandboxEnabled === true, subagentsEnabled: value.subagentsEnabled === true,
  };
}

function normalizeConnector(raw: unknown): ConnectorOption | null {
  if (typeof raw === "string") return { name: raw, tools: [] };
  if (!isRecord(raw) || typeof raw.name !== "string") return null;
  return { name: raw.name, url: typeof raw.url === "string" ? raw.url : undefined,
    tools: Array.isArray(raw.tools) ? raw.tools.map((tool) => {
      if (typeof tool === "string") return { name: tool };
      return isRecord(tool) && typeof tool.name === "string"
        ? { name: tool.name, description: typeof tool.description === "string" ? tool.description : undefined } : null;
    }).filter(Boolean) as ToolOption[] : [] };
}

function normalizeModel(raw: unknown): ModelOption | null {
  if (typeof raw === "string") return { name: raw };
  return isRecord(raw) && typeof raw.name === "string" ? { name: raw.name } : null;
}

function normalizeServer(raw: unknown): McpServerConfig | null {
  if (!isRecord(raw) || typeof raw.name !== "string") return null;
  return {
    name: raw.name,
    enableTools: stringArray(raw.enableTools),
    disableTools: stringArray(raw.disableTools),
    preloadTools: stringArray(raw.preloadTools),
    preload: typeof raw.preload === "boolean" ? raw.preload : undefined,
    requireApprovalForTools: stringArray(raw.requireApprovalForTools),
  };
}

function connectorCatalog(connectors: ConnectorOption[]): ConnectorOption[] {
  const core = connectors.find((connector) => connector.name === CORE_CONNECTOR);
  const tools = unique([...CORE_TOOLS, ...(core?.tools.map((tool) => tool.name) ?? [])])
    .map((name) => core?.tools.find((tool) => tool.name === name) ?? { name });
  return [{ name: CORE_CONNECTOR, url: core?.url, tools }, ...connectors.filter((connector) => connector.name !== CORE_CONNECTOR)];
}

function newDraft(catalog: AgentCatalog): DraftAgent {
  return { id: null, slug: "", name: "", description: "", instructions: "", isDefault: false, enabled: true,
    model: catalog.models.find((item) => item.name === CHEAP_MODEL)?.name ?? catalog.models[0]?.name ?? CHEAP_MODEL,
    mcpServers: [{ name: CORE_CONNECTOR, enableTools: [...CORE_TOOLS], requireApprovalForTools: [] }],
    sandboxEnabled: false, subagentsEnabled: false };
}

function toDraft(agent: AgentProfile): DraftAgent {
  return { id: agent.id, slug: agent.slug, name: agent.name, description: agent.description,
    instructions: agent.instructions, isDefault: agent.isDefault, enabled: agent.enabled, model: agent.model,
    mcpServers: withRequiredCoreTools(agent.mcpServers), sandboxEnabled: agent.sandboxEnabled,
    subagentsEnabled: agent.subagentsEnabled };
}

function withRequiredCoreTools(servers: McpServerConfig[]): McpServerConfig[] {
  const core = servers.find((server) => server.name === CORE_CONNECTOR);
  return [{ ...core, name: CORE_CONNECTOR, enableTools: unique([...(core?.enableTools ?? []), ...CORE_TOOLS]),
    disableTools: core?.disableTools?.filter((name) =>
      !CORE_TOOLS.includes(name) && name !== "@all" && name !== "@read-only"
    ),
    preloadTools: core?.preloadTools ? [...core.preloadTools] : undefined,
    requireApprovalForTools: (core?.requireApprovalForTools ?? []).filter((name) => !CORE_TOOLS.includes(name)) },
  ...servers.filter((server) => server.name !== CORE_CONNECTOR).map((server) => ({ ...server,
    enableTools: server.enableTools ? [...server.enableTools] : undefined,
    disableTools: server.disableTools ? [...server.disableTools] : undefined,
    preloadTools: server.preloadTools ? [...server.preloadTools] : undefined,
    requireApprovalForTools: server.requireApprovalForTools ? [...server.requireApprovalForTools] : undefined }))];
}

function selectedToolNames(server: McpServerConfig, connector: ConnectorOption): string[] {
  const enabled = server.enableTools ?? connector.tools.map((tool) => tool.name);
  const disabled = new Set(server.disableTools ?? []);
  if (disabled.has("@all")) return [];
  return enabled.filter((name) => !disabled.has(name));
}

function comparableAgent(agent: AgentProfile | DraftAgent): string {
  return JSON.stringify({ slug: agent.slug, name: agent.name, description: agent.description,
    instructions: agent.instructions, enabled: agent.enabled, model: agent.model,
    mcpServers: withRequiredCoreTools(agent.mcpServers).map((server) => ({ name: server.name,
      enableTools: [...(server.enableTools ?? [])].sort(),
      disableTools: [...(server.disableTools ?? [])].sort(),
      preloadTools: [...(server.preloadTools ?? [])].sort(),
      preload: server.preload,
      requireApprovalForTools: [...(server.requireApprovalForTools ?? [])].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
    sandboxEnabled: agent.sandboxEnabled, subagentsEnabled: agent.subagentsEnabled });
}

function hasNewAgentContent(draft: DraftAgent): boolean {
  return Boolean(draft.name || draft.slug || draft.description || draft.instructions || draft.sandboxEnabled
    || draft.subagentsEnabled || draft.mcpServers.some((server) => server.name !== CORE_CONNECTOR));
}

function inputClass(readOnly: boolean): string {
  return `w-full rounded-md border px-3 py-2.5 text-sm outline-none ${readOnly
    ? "cursor-default border-line bg-deck text-ink-faint"
    : "border-line-strong bg-panel text-ink placeholder:text-ink-faint focus:border-signal"}`;
}
function isCoreTool(connector: string, tool: string): boolean { return connector === CORE_CONNECTOR && CORE_TOOLS.includes(tool); }
function connectorLabel(name: string): string { return name === CORE_CONNECTOR ? "Mission Control" : name.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function shortModelName(name: string): string { return name.split("/").at(-1) || "No model"; }
function slugPreview(value: string): string { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48); }
function unique(values: string[]): string[] { return [...new Set(values)]; }
function stringArray(value: unknown): string[] | undefined { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined; }
function stringValue(value: unknown): string { return typeof value === "string" ? value : ""; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
