"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface AgentProfile {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  isDefault: boolean;
  enabled: boolean;
  updatedAt: string | null;
}

interface DraftAgent {
  id: string | null;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  isDefault: boolean;
  enabled: boolean;
}

const EMPTY_DRAFT: DraftAgent = {
  id: null,
  slug: "",
  name: "",
  description: "",
  instructions: "",
  isDefault: false,
  enabled: true,
};

export default function AgentsPage() {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [draft, setDraft] = useState<DraftAgent | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadAgents = useCallback(async (preferredId?: string) => {
    const response = await fetch("/api/agents", { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load agents.");
    const next = (await response.json()) as AgentProfile[];
    setAgents(next);
    setDraft((current) => {
      if (current?.id === null && !preferredId) return current;
      const selected =
        next.find((agent) => agent.id === preferredId) ??
        next.find((agent) => agent.slug === current?.slug) ??
        next[0];
      return selected ? toDraft(selected) : EMPTY_DRAFT;
    });
  }, []);

  useEffect(() => {
    void fetch("/api/agents", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load agents.");
        return response.json() as Promise<AgentProfile[]>;
      })
      .then((next) => {
        setAgents(next);
        setDraft(next[0] ? toDraft(next[0]) : EMPTY_DRAFT);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const dirty = useMemo(() => {
    if (!draft) return false;
    if (draft.id === null) return Boolean(draft.name || draft.description || draft.instructions);
    const source = agents.find((agent) => agent.id === draft.id || agent.slug === draft.slug);
    if (!source) return true;
    return (
      source.name !== draft.name ||
      source.description !== draft.description ||
      source.instructions !== draft.instructions ||
      source.enabled !== draft.enabled
    );
  }, [agents, draft]);

  function selectAgent(agent: AgentProfile) {
    if (saving) return;
    setError(null);
    setDraft(toDraft(agent));
  }

  async function save() {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        draft.id ? `/api/agents/${encodeURIComponent(draft.id)}` : "/api/agents",
        {
          method: draft.id ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(draft),
        }
      );
      const result = (await response.json().catch(() => ({}))) as AgentProfile & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Could not save agent.");
      await loadAgents(result.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="flex h-full min-w-0 flex-col bg-deck">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-deck px-5 sm:px-6">
        <div>
          <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">Agent library</p>
          <h1 className="mt-0.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">Specialists</h1>
        </div>
        <p className="hidden max-w-md text-xs leading-relaxed text-ink-faint md:block">
          Every task snapshots its agent instructions when the Squad Lead creates it.
        </p>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setDraft(EMPTY_DRAFT);
          }}
          className="ml-auto rounded-md bg-signal px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:brightness-110"
        >
          New agent
        </button>
      </header>

      {loading ? (
        <p className="p-6 font-mono text-xs text-ink-faint">Loading agents...</p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_290px]">
          <aside className="scrollbar-none order-1 max-h-52 overflow-y-auto border-b border-line bg-panel/55 p-3 md:order-2 md:max-h-none md:border-b-0 md:border-l">
            <p className="px-2 pb-2 font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">
              {agents.filter((agent) => agent.enabled).length} active
            </p>
            <div className="space-y-1.5">
              {agents.map((agent) => {
                const active = draft?.id === agent.id || (draft?.id !== null && draft?.slug === agent.slug);
                return (
                  <button
                    key={agent.id}
                    type="button"
                    onClick={() => selectAgent(agent)}
                    className={`block w-full rounded-md border px-3 py-3 text-left transition-colors ${
                      active
                        ? "border-line-strong bg-panel-hi text-ink"
                        : "border-transparent text-ink-soft hover:border-line hover:bg-panel-hi/70 hover:text-ink"
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="truncate text-xs font-semibold">{agent.name}</span>
                      {!agent.enabled && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-ink-faint" aria-label="Disabled" />}
                    </span>
                    <span className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-ink-faint">{agent.description}</span>
                    <span className="mt-2 block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
                      {agent.isDefault ? "Default" : "Custom"} / {agent.slug}
                    </span>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="console-grid order-2 min-h-0 overflow-y-auto px-5 py-6 sm:px-8 md:order-1 lg:px-12">
            {draft && (
              <div className="mx-auto max-w-3xl">
                <div className="mb-6 flex items-start justify-between gap-5">
                  <div>
                    <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-role-writer">
                      {draft.id ? (draft.isDefault ? "Default agent" : "Custom agent") : "New custom agent"}
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold tracking-[-0.035em] text-ink">
                      {draft.id ? draft.name : "Build a reusable specialist"}
                    </h2>
                  </div>
                  {draft.id && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-soft">
                      <input
                        type="checkbox"
                        checked={draft.enabled}
                        onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
                        className="accent-[var(--color-signal)]"
                      />
                      Available to Squad Lead
                    </label>
                  )}
                </div>

                <div className="grid gap-5 sm:grid-cols-2">
                  <label className="block">
                    <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Name</span>
                    <input
                      value={draft.name}
                      onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                      maxLength={64}
                      placeholder="Release manager"
                      className="w-full rounded-md border border-line-strong bg-panel px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-signal"
                    />
                  </label>
                  <label className="block">
                    <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Role id</span>
                    <input
                      value={draft.slug || slugPreview(draft.name)}
                      readOnly
                      tabIndex={-1}
                      className="w-full rounded-md border border-line bg-deck px-3 py-2.5 font-mono text-xs text-ink-faint outline-none"
                    />
                  </label>
                </div>

                <label className="mt-5 block">
                  <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">What this agent is for</span>
                  <input
                    value={draft.description}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                    maxLength={240}
                    placeholder="One sentence the Squad Lead can use when choosing an agent."
                    className="w-full rounded-md border border-line-strong bg-panel px-3 py-2.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-signal"
                  />
                </label>

                <label className="mt-5 block">
                  <span className="mb-2 block font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">System instructions</span>
                  <textarea
                    value={draft.instructions}
                    onChange={(event) => setDraft({ ...draft, instructions: event.target.value })}
                    rows={16}
                    placeholder="Define scope, workflow, quality bar, tool behavior, and what the final report must contain."
                    className="scrollbar-none min-h-[320px] w-full resize-y rounded-md border border-line-strong bg-panel p-4 font-mono text-[12px] leading-6 text-ink outline-none placeholder:text-ink-faint focus:border-signal"
                  />
                </label>

                {error && (
                  <p className="mt-4 rounded-md border border-state-blocked/30 bg-state-blocked/[0.04] px-3 py-2.5 text-xs text-state-blocked">
                    {error}
                  </p>
                )}

                <div className="mt-5 flex items-center gap-3 border-t border-line pt-5">
                  <p className="text-[10px] leading-relaxed text-ink-faint">
                    Changes apply only to tasks created after you save.
                  </p>
                  <button
                    type="button"
                    onClick={() => void save()}
                    disabled={!dirty || saving}
                    className="ml-auto rounded-md bg-ink px-4 py-2.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:bg-white disabled:opacity-30"
                  >
                    {saving ? "Saving..." : draft.id ? "Save changes" : "Create agent"}
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function toDraft(agent: AgentProfile): DraftAgent {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    isDefault: agent.isDefault,
    enabled: agent.enabled,
  };
}

function slugPreview(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
