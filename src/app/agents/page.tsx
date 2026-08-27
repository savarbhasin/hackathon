"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

const CHEAP_MODEL = "openai/gpt-5-6-luna";
const CORE_CONNECTOR = "mission-control";
const CORE_TOOLS = ["mark_done", "create_doc", "update_doc", "get_doc"];
const EMPTY_CATALOG: AgentCatalog = { agents: [], connectors: [], models: [], capabilities: { sandbox: false } };

export default function AgentsPage() {
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY_CATALOG);
  const [draft, setDraft] = useState<DraftAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connectorSearch, setConnectorSearch] = useState("");

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

  function replaceServer(next: McpServerConfig) {
    if (!draft) return;
    const exists = draft.mcpServers.some((server) => server.name === next.name);
    updateDraft({ mcpServers: exists
      ? draft.mcpServers.map((server) => server.name === next.name ? next : server)
      : [...draft.mcpServers, next] });
  }

  function setToolEnabled(connector: ConnectorOption, toolName: string, enabled: boolean) {
    if (!draft || isCoreTool(connector.name, toolName)) return;
    const server = draft.mcpServers.find((item) => item.name === connector.name);
    const current = server ? selectedToolNames(server, connector) : [];
    const enableTools = enabled ? unique([...current, toolName]) : current.filter((name) => name !== toolName);
    replaceServer({
      name: connector.name,
      ...server,
      enableTools,
      disableTools: (server?.disableTools ?? []).filter((name) => name !== toolName && name !== "@all"),
      requireApprovalForTools: (server?.requireApprovalForTools ?? []).filter((name) => enableTools.includes(name)),
    });
  }

  function setAllTools(connector: ConnectorOption, enabled: boolean) {
    if (!draft || connector.name === CORE_CONNECTOR) return;
    const server = draft.mcpServers.find((item) => item.name === connector.name);
    const enableTools = enabled ? connector.tools.map((tool) => tool.name) : [];
    replaceServer({
      name: connector.name,
      ...server,
      enableTools,
      disableTools: (server?.disableTools ?? []).filter((name) => name !== "@all" && !connector.tools.some((tool) => tool.name === name)),
      requireApprovalForTools: enabled
        ? (server?.requireApprovalForTools ?? []).filter((name) => enableTools.includes(name))
        : [],
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
  const connectorTerm = connectorSearch.trim().toLowerCase();
  const visibleConnectors = connectorTerm
    ? connectors.filter((connector) => connectorLabel(connector.name).toLowerCase().includes(connectorTerm))
    : connectors;
  const orderedConnectors = [...visibleConnectors].sort((left, right) =>
    connectorPriority(left, draft) - connectorPriority(right, draft)
  );

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

      {loading ? <AgentLoading /> : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_290px]">
          <aside className="order-1 min-h-0 max-h-52 overflow-y-auto border-b border-line bg-panel/55 p-3 md:order-2 md:h-full md:max-h-none md:border-b-0 md:border-l">
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

              {draft.id ? (
                <div className="mb-7">
                  <FieldLabel label="Description">
                    <textarea value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })}
                      rows={3} placeholder="Describe what this agent is best at and when the Squad Lead should use it."
                      className={`${inputClass(false)} min-h-[5.5rem] resize-y leading-relaxed`} />
                  </FieldLabel>
                  <p className="mt-2 text-[10px] leading-relaxed text-ink-faint">
                    Used by the Squad Lead when choosing a specialist.
                  </p>
                </div>
              ) : (
                <EditorSection eyebrow="Identity" title="Set up this agent"
                  description="Choose the name and role ID the Squad Lead will use for this new specialist.">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FieldLabel label="Name">
                      <input value={draft.name} onChange={(event) => updateName(event.target.value)}
                        maxLength={64} placeholder="Release manager" className={inputClass(false)} />
                    </FieldLabel>
                    <FieldLabel label="Role id">
                      <input value={draft.slug} onChange={(event) => updateDraft({ slug: slugPreview(event.target.value) })}
                        maxLength={48} placeholder="release-manager" className={`${inputClass(false)} font-mono text-xs`} />
                    </FieldLabel>
                  </div>
                  <FieldLabel label="Description" className="mt-5">
                    <textarea value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })}
                      rows={3} placeholder="Describe what this agent is best at and when the Squad Lead should use it."
                      className={`${inputClass(false)} min-h-[5.5rem] resize-y leading-relaxed`} />
                  </FieldLabel>
                </EditorSection>
              )}

              <EditorSection eyebrow="Runtime" title="Model and agent capabilities"
                description="Use the lightest model that can do the work. Enable sandbox or subagents only when the assignment needs them.">
                <div className="space-y-5">
                  <ModelSelect models={catalog.models} value={draft.model}
                    onChange={(model) => updateDraft({ model })} />
                  <div>
                    <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.13em] text-ink-faint">Capabilities</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      <CapabilityToggle label="Sandbox"
                        description={catalog.capabilities.sandbox ? "Files, commands, and code execution" : "Unavailable in TrueForge"}
                        checked={draft.sandboxEnabled} disabled={!catalog.capabilities.sandbox}
                        onChange={(checked) => updateDraft({ sandboxEnabled: checked })} />
                      <CapabilityToggle label="Subagents" description="Can split work into parallel specialist threads"
                        checked={draft.subagentsEnabled} onChange={(checked) => updateDraft({ subagentsEnabled: checked })} />
                    </div>
                  </div>
                </div>
              </EditorSection>

              <EditorSection eyebrow="Tools" title="Connectors and approval gates"
                description="Select only the connectors this role needs. Approval gates pause the task before the chosen tool runs.">
                <label className="relative mb-3 block">
                  <span className="sr-only">Search connectors</span>
                  <input value={connectorSearch} onChange={(event) => setConnectorSearch(event.target.value)} placeholder="Search connectors"
                    className="w-full rounded-md border border-line bg-deck px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-signal" />
                </label>
                <div className="h-[26rem] overflow-y-auto overscroll-contain pr-1">
                  <div className="space-y-3">
                    {orderedConnectors.map((connector) => {
                      const server = draft.mcpServers.find((item) => item.name === connector.name);
                      const required = connector.name === CORE_CONNECTOR;
                      return <ConnectorEditor key={connector.name} connector={connector} server={server}
                        required={required}
                        onToolToggle={(tool, checked) => setToolEnabled(connector, tool, checked)}
                        onAllToolsToggle={(checked) => setAllTools(connector, checked)}
                        onApprovalToggle={(tool, checked) => setToolApproval(connector, tool, checked)} />;
                    })}
                    {orderedConnectors.length === 0 && <p className="rounded-md border border-line px-4 py-5 text-xs leading-relaxed text-ink-faint">
                      No connectors match {connectorSearch}.
                    </p>}
                    {connectors.length === 1 && orderedConnectors.length > 0 && <p className="rounded-md border border-dashed border-line px-4 py-5 text-xs leading-relaxed text-ink-faint">
                      No external connectors are configured. Add one in TrueForge to make it available here.
                    </p>}
                  </div>
                </div>
              </EditorSection>

              <EditorSection eyebrow="Behavior" title="System instructions"
                description="Define the scope, working method, tool rules, and what a finished result must contain.">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="text-[10px] leading-relaxed text-ink-faint">Markdown is supported. Use headings and bullets to make the workflow easy to scan.</p>
                  <span className="rounded border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">Markdown</span>
                </div>
                <textarea value={draft.instructions} onChange={(event) => updateDraft({ instructions: event.target.value })}
                  rows={16} placeholder="## Role\n\nDescribe this agent's scope, workflow, and completion rule."
                  className="scrollbar-none min-h-[320px] w-full resize-y rounded-md border border-line-strong bg-panel p-4 font-mono text-[12px] leading-6 text-ink outline-none placeholder:text-ink-faint focus:border-signal" />
                {draft.instructions.trim() && <div className="markdown mt-4 rounded-md border border-line bg-panel/60 p-4 text-xs">
                  <p className="mb-3 font-mono text-[8px] uppercase tracking-[0.14em] text-ink-faint">Preview</p>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.instructions}</ReactMarkdown>
                </div>}
                <p className="mt-2 text-right font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
                  {draft.instructions.trim().length} characters / 40 minimum
                </p>
              </EditorSection>

              {error && <p className="mt-5 rounded-md border border-state-blocked/30 bg-state-blocked/[0.04] px-3 py-2.5 text-xs text-state-blocked">{error}</p>}
              {dirty && <div className="sticky bottom-3 -mx-3 mt-6 flex items-center gap-3 rounded-lg border border-line-strong bg-deck/95 px-5 py-4 shadow-[0_8px_24px_rgba(0,0,0,0.16)] backdrop-blur-sm sm:-mx-5 sm:px-6">
                  <p className="text-[10px] leading-relaxed text-ink-faint">
                    Changes apply to future turns, including resumed paused tasks.
                  </p>
                  <button type="button" onClick={() => void save()} disabled={!valid || saving}
                    className="ml-auto rounded-md bg-ink px-4 py-2.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:bg-white disabled:opacity-30">
                    {saving ? "Saving..." : draft.id ? "Save changes" : "Create agent"}
                  </button>
                </div>}
            </div>}
          </section>
        </div>
      )}
    </main>
  );
}

function ModelSelect({ models, value, onChange }: {
  models: ModelOption[]; value: string; onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selected = models.find((model) => model.name === value) ?? { name: value };
  const providers = unique(models.map((model) => modelProvider(model.name))).sort((left, right) => {
    const order = ["OpenAI", "Gemini", "Other"];
    return order.indexOf(left) - order.indexOf(right);
  });
  const [activeProvider, setActiveProvider] = useState(() => modelProvider(value));
  const popoverRef = useRef<HTMLDivElement>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleModels = models.filter((model) => modelProvider(model.name) === activeProvider
    && (!normalizedQuery || `${modelDisplayName(model.name)} ${modelDescription(model.name)}`.toLowerCase().includes(normalizedQuery)));

  useEffect(() => {
    if (!open) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (!popoverRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  function toggleOpen() {
    if (!open) {
      setActiveProvider(modelProvider(selected.name));
      setQuery("");
    }
    setOpen(!open);
  }

  return <div>
    <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Model</p>
    <div ref={popoverRef} className="relative">
      <button type="button" aria-haspopup="listbox" aria-expanded={open} onClick={toggleOpen}
        className="flex w-full items-center gap-3 rounded-md border border-line-strong bg-panel px-3 py-2.5 text-left text-sm text-ink outline-none transition-colors hover:border-signal focus:border-signal">
        <ModelBadge name={selected.name} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold">{selected.name ? modelDisplayName(selected.name) : "No models configured"}</span>
          <span className="mt-0.5 block truncate text-[10px] text-ink-faint">{selected.name ? modelDescription(selected.name) : "Add a model in TrueForge to continue."}</span>
        </span>
        <svg viewBox="0 0 12 12" aria-hidden="true" className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m2.5 4.25 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && <div className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl">
        <div className="border-b border-line p-3">
          <label className="relative block">
            <span className="sr-only">Search models</span>
            <svg viewBox="0 0 20 20" aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint">
              <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <path d="m12.5 12.5 4 4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
            <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search models"
              className="w-full rounded-md border border-line bg-deck py-2 pl-9 pr-3 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-signal" />
          </label>
        </div>
        <div className="grid min-h-56 max-h-80 grid-cols-[112px_minmax(0,1fr)]">
          <div className="border-r border-line bg-deck/45 p-2" aria-label="Model companies">
            {providers.map((provider) => <button key={provider} type="button" onClick={() => setActiveProvider(provider)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2.5 text-left text-xs font-medium transition-colors ${provider === activeProvider ? "bg-panel-hi text-ink" : "text-ink-faint hover:bg-panel-hi/60 hover:text-ink-soft"}`}>
              <ModelBadge name={provider} compact />
              <span className="truncate">{provider}</span>
            </button>)}
          </div>
          <div role="listbox" aria-label={`${activeProvider} models`} className="overflow-y-auto p-2">
            {visibleModels.map((model) => <button key={model.name} type="button" role="option" aria-selected={model.name === value}
              onClick={() => { onChange(model.name); setOpen(false); }}
              className={`block w-full rounded-md px-3 py-3 text-left transition-colors ${model.name === value ? "bg-signal/[0.1] text-ink" : "text-ink-soft hover:bg-panel-hi hover:text-ink"}`}>
              <span className="block text-xs font-semibold">{modelDisplayName(model.name)}</span>
              <span className="mt-1 block text-[10px] leading-relaxed text-ink-faint">{modelDescription(model.name)}</span>
            </button>)}
            {visibleModels.length === 0 && <p className="px-3 py-5 text-xs leading-relaxed text-ink-faint">No {activeProvider} models match your search.</p>}
          </div>
        </div>
      </div>}
    </div>
  </div>;
}

function ModelBadge({ name, compact = false }: { name: string; compact?: boolean }) {
  const provider = modelProvider(name);
  return <span className={`flex shrink-0 items-center justify-center rounded-md border ${compact ? "h-6 w-6" : "h-8 w-8"} ${provider === "Gemini"
    ? "border-blue-300/30 bg-blue-400/10 text-blue-200" : provider === "OpenAI" ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-200" : "border-line bg-deck text-ink-soft"}`} aria-hidden="true">
    {provider === "Gemini" ? <svg viewBox="0 0 24 24" className={`${compact ? "h-4 w-4" : "h-5 w-5"} fill-current`}><path d="M12 2.5c.8 4.8 4.7 8.7 9.5 9.5-4.8.8-8.7 4.7-9.5 9.5-.8-4.8-4.7-8.7-9.5-9.5 4.8-.8 8.7-4.7 9.5-9.5Z" /></svg>
      : provider === "OpenAI" ? <svg viewBox="0 0 24 24" className={`${compact ? "h-4 w-4" : "h-5 w-5"} fill-none stroke-current`} strokeWidth="1.7"><path d="M12 4.4a4.1 4.1 0 0 1 7.1 3.1 4.1 4.1 0 0 1 1.2 7.6 4.1 4.1 0 0 1-4.6 5.9 4.1 4.1 0 0 1-7.2-3.1 4.1 4.1 0 0 1-1.2-7.6A4.1 4.1 0 0 1 12 4.4Z" /><path d="m12 4.4 3.7 2.2v4.3l-3.7 2.1-3.7-2.1V6.6L12 4.4Zm0 8.6 3.7 2.1v4.3M12 13l-3.7 2.1" /></svg>
        : <span className="text-[8px] font-bold">AI</span>}
  </span>;
}

function modelProvider(name: string): string {
  const model = name.toLowerCase();
  if (model.includes("gemini") || model.includes("google")) return "Gemini";
  if (model.includes("openai") || model.includes("gpt")) return "OpenAI";
  return "Other";
}

function modelDisplayName(name: string): string {
  const short = name.split("/").at(-1)?.toLowerCase() ?? name.toLowerCase();
  const gpt = short.match(/^gpt-(\d+)-(\d+)(?:-(.+))?$/);
  if (gpt) return `GPT-${gpt[1]}.${gpt[2]}${gpt[3] ? ` ${titleCaseModelPart(gpt[3])}` : ""}`;
  const gemini = short.match(/^gemini-(\d+)-(\d+)(?:-(.+))?$/);
  if (gemini) return `Gemini ${gemini[1]}.${gemini[2]}${gemini[3] ? ` ${titleCaseModelPart(gemini[3])}` : ""}`;
  return titleCaseModelPart(short);
}

function titleCaseModelPart(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function modelDescription(name: string): string {
  const short = name.split("/").at(-1)?.toLowerCase() ?? name.toLowerCase();
  const descriptions: Record<string, string> = {
    "gpt-5-6-sol": "OpenAI model for complex reasoning and coding.",
    "gpt-5-6-terra": "Balanced OpenAI model for coding and reasoning.",
    "gpt-5-6-luna": "Fast, efficient OpenAI model for everyday workflows.",
    "gpt-5-5": "General-purpose OpenAI model for reasoning, writing, and coding.",
    "gpt-5-4-mini": "Smaller OpenAI model tuned for speed and focused tasks.",
    "gemini-3-1-pro-preview": "Advanced Gemini model for complex reasoning and demanding work.",
    "gemini-3-6-flash": "Fast Gemini model for efficient, responsive workflows.",
  };
  return descriptions[short] ?? `${modelProvider(name)} model for agent tasks.`;
}

function AgentLoading() {
  return <div role="status" aria-label="Loading agents" aria-busy="true"
    className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_290px]">
    <aside className="order-1 max-h-52 overflow-hidden border-b border-line bg-panel/55 p-3 md:order-2 md:max-h-none md:border-b-0 md:border-l">
      <div className="h-2 w-14 rounded shimmer" />
      <div className="mt-3 space-y-1.5">
        {Array.from({ length: 5 }, (_, index) => <div key={index} className="rounded-md border border-line/70 bg-panel/45 px-3 py-3">
          <div className={`h-3 rounded shimmer ${index % 2 === 0 ? "w-24" : "w-32"}`} />
          <div className="mt-2 h-2.5 w-4/5 rounded shimmer" />
          <div className="mt-2 h-2 w-20 rounded shimmer" />
        </div>)}
      </div>
    </aside>
    <section className="console-grid order-2 min-h-0 overflow-hidden px-5 py-6 sm:px-8 md:order-1 lg:px-12">
      <div className="mx-auto max-w-5xl">
        <div className="mb-7 flex items-start justify-between gap-5">
          <div>
            <div className="h-2 w-24 rounded shimmer" />
            <div className="mt-3 h-7 w-56 rounded shimmer" />
          </div>
          <div className="h-9 w-44 rounded-md border border-line shimmer" />
        </div>
        <div className="mb-7 max-w-2xl">
          <div className="h-2 w-20 rounded shimmer" />
          <div className="mt-2 h-10 w-full rounded-md border border-line-strong shimmer" />
        </div>
        <div className="space-y-5">
          {["w-48", "w-64", "w-56"].map((width) => <div key={width} className="rounded-lg border border-line bg-deck/55 p-5">
            <div className={`h-2.5 rounded shimmer ${width}`} />
            <div className="mt-2 h-2 w-3/5 rounded shimmer" />
            <div className="mt-5 h-20 rounded-md border border-line shimmer" />
          </div>)}
        </div>
      </div>
    </section>
  </div>;
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
    className={`group flex min-h-0 w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal ${disabled
      ? "cursor-not-allowed border-line bg-deck opacity-55"
      : checked ? "border-signal/70 bg-signal/[0.07]" : "border-line bg-transparent hover:border-line-strong hover:bg-panel/45"}`}>
      <span className="min-w-0"><span className="block text-xs font-semibold text-ink">{label}</span>
      <span className="mt-1 block text-[10px] leading-5 text-ink-faint">{description}</span></span>
    <span className={`mt-0.5 shrink-0 rounded border px-1.5 py-1 font-mono text-[8px] uppercase tracking-[0.1em] ${checked
      ? "border-signal/60 bg-signal text-deck" : "border-line text-ink-faint group-hover:text-ink-soft"}`}>
      {checked ? "On" : "Off"}
    </span>
  </button>;
}

function ConnectorEditor({ connector, server, required, onToolToggle, onAllToolsToggle, onApprovalToggle }: {
  connector: ConnectorOption;
  server?: McpServerConfig;
  required: boolean;
  onToolToggle: (tool: string, checked: boolean) => void;
  onAllToolsToggle: (checked: boolean) => void;
  onApprovalToggle: (tool: string, checked: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const enabledTools = server ? selectedToolNames(server, connector) : [];
  const approvals = server?.requireApprovalForTools ?? [];
  const label = connectorLabel(connector.name);
  const toolsId = `connector-tools-${connector.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const enabledCount = connector.tools.filter((tool) => isCoreTool(connector.name, tool.name) || enabledTools.includes(tool.name)).length;
  const hasExternalTools = connector.tools.some((tool) => !isCoreTool(connector.name, tool.name));
  const orderedTools = [...connector.tools].sort((left, right) => {
    const leftCore = isCoreTool(connector.name, left.name);
    const rightCore = isCoreTool(connector.name, right.name);
    if (leftCore !== rightCore) return Number(rightCore) - Number(leftCore);
    const leftEnabled = leftCore || enabledTools.includes(left.name);
    const rightEnabled = rightCore || enabledTools.includes(right.name);
    return Number(rightEnabled) - Number(leftEnabled);
  });
  const visibleTools = orderedTools.filter((tool) => {
    const term = search.trim().toLowerCase();
    return !term || tool.name.toLowerCase().includes(term) || tool.description?.toLowerCase().includes(term);
  });
  return <div className={`overflow-hidden rounded-md border ${enabledCount > 0 ? "border-signal/55 bg-signal/[0.045]" : "border-line bg-deck/45"}`}>
    <div className="flex min-h-14 items-stretch">
      <button type="button" onClick={() => setExpanded((current) => !current)} aria-expanded={expanded}
        aria-controls={toolsId}
        className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-panel-hi/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-semibold text-ink">{label}</span>
          <span className="mt-0.5 block font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">
            {enabledCount > 0
              ? `Uses ${enabledCount} of ${connector.tools.length} ${connector.tools.length === 1 ? "tool" : "tools"}`
              : "Not used"}
          </span>
        </span>
        {required && <span className="rounded border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">Core</span>}
        {enabledCount > 0 && <span className="rounded border border-signal/35 bg-signal/[0.08] px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-signal">Enabled</span>}
        <svg viewBox="0 0 12 12" aria-hidden="true"
          className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${expanded ? "rotate-90" : ""}`}>
          <path d="m4.25 2.25 3.5 3.75-3.5 3.75" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
    {expanded && <div id={toolsId} className="border-t border-line">
      {connector.tools.length > 0 ? <>
        <div className="flex flex-col gap-3 border-b border-line/70 px-4 py-3 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1">
            <span className="sr-only">Search {label} tools</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search tools"
              className="w-full rounded-md border border-line bg-deck px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-signal" />
          </label>
          {required ? <span className="font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">Core tools stay enabled</span> : <div className="flex shrink-0 gap-2">
            <button type="button" onClick={() => onAllToolsToggle(true)} disabled={!hasExternalTools}
              className="rounded border border-line px-2.5 py-2 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">Select all</button>
            <button type="button" onClick={() => onAllToolsToggle(false)} disabled={enabledCount === 0}
              className="rounded border border-line px-2.5 py-2 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40">Deselect all</button>
          </div>}
        </div>
        <div className="h-72 overflow-y-auto overscroll-contain">
          <div className="sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_70px] gap-3 border-b border-line/70 bg-panel px-4 py-2 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
            <span>Enabled tools</span><span className="text-center">Approval</span>
          </div>
          {visibleTools.map((tool) => {
            const core = isCoreTool(connector.name, tool.name);
            const enabled = core || enabledTools.includes(tool.name);
            const toolLocked = core;
            return <div key={tool.name} className="grid grid-cols-[minmax(0,1fr)_70px] items-center gap-3 border-b border-line/50 px-4 py-3 last:border-b-0">
              <div className="flex items-start gap-3">
                <label className={`mt-0.5 ${toolLocked ? "cursor-not-allowed" : "cursor-pointer"}`}>
                  <input type="checkbox" checked={enabled} disabled={toolLocked}
                    onChange={(event) => onToolToggle(tool.name, event.target.checked)}
                    aria-label={`${enabled ? "Disable" : "Enable"} ${tool.name}`}
                    className="accent-[var(--color-signal)]" />
                </label>
                <div className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[10px] font-medium text-ink">{tool.name}</span>
                    {core && <span className="font-mono text-[7px] uppercase tracking-[0.12em] text-state-settled">Required</span>}
                  </span>
                  {tool.description && <div className="tool-description-markdown mt-1">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{tool.description}</ReactMarkdown>
                  </div>}
                </div>
              </div>
              <label className={`flex justify-center ${enabled && !core ? "cursor-pointer" : "cursor-not-allowed opacity-35"}`}
                title={core ? "Mission Control core tools run without an approval gate" : "Pause before this tool runs"}>
                <input type="checkbox" checked={approvals.includes(tool.name)} disabled={!enabled || core}
                  onChange={(event) => onApprovalToggle(tool.name, event.target.checked)}
                  aria-label={`Require approval for ${tool.name}`} className="accent-[var(--color-state-approval)]" />
              </label>
            </div>;
          })}
          {visibleTools.length === 0 && <p className="px-4 py-5 text-xs text-ink-faint">No tools match {search}.</p>}
        </div>
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
    sandboxEnabled: value.sandboxEnabled === true,
    subagentsEnabled: value.subagentsEnabled === true,
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

function connectorPriority(connector: ConnectorOption, draft: DraftAgent | null): number {
  if (connector.name === CORE_CONNECTOR) return 0;
  const server = draft?.mcpServers.find((item) => item.name === connector.name);
  return server && selectedToolNames(server, connector).length > 0 ? 1 : 2;
}

function selectedToolNames(server: McpServerConfig, connector: ConnectorOption): string[] {
  const enabled = server.enableTools ?? connector.tools.map((tool) => tool.name);
  const disabled = new Set(server.disableTools ?? []);
  if (disabled.has("@all")) return [];
  const selected = enabled.includes("@all") ? connector.tools.map((tool) => tool.name) : enabled;
  return selected.filter((name) => !disabled.has(name));
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
