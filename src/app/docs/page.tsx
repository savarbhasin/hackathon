"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "@/components/confirm-dialog";

const MarkdownDocumentEditor = dynamic(
  () => import("@/components/markdown-document-editor").then((module) => module.MarkdownDocumentEditor),
  { ssr: false, loading: () => <div className="min-h-96 animate-pulse rounded-lg border border-line bg-panel-hi" /> }
);

interface AgentDocument {
  id: string;
  title: string;
  content: string;
  authorRole: string;
  kind: string;
  createdAt: string;
  updatedAt: string;
  mission: { id: string; title: string } | null;
  task: { id: string; title: string; role: string } | null;
}

interface DocumentDraft {
  title: string;
  content: string;
}

type DocumentGroupId = "mine" | "agents" | "handoffs";

export default function DocsPage() {
  const [documents, setDocuments] = useState<AgentDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DocumentDraft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeGroup, setActiveGroup] = useState<DocumentGroupId>("mine");

  useEffect(() => {
    void fetch("/api/docs", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load documents.");
        return response.json() as Promise<AgentDocument[]>;
      })
      .then((items) => {
        setDocuments(items);
        const requestedId = new URLSearchParams(window.location.search).get("document");
        const initial = items.find((document) => document.id === requestedId) ?? items[0];
        setSelectedId(initial?.id ?? null);
        if (initial) setActiveGroup(documentGroupId(initial));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setLoading(false));
  }, []);

  const selected = documents.find((document) => document.id === selectedId) ?? null;
  const draft = selected ? drafts[selected.id] ?? pickDraft(selected) : null;
  const dirty = Boolean(selected && drafts[selected.id]);
  const selectedDocumentId = selected?.id;
  const draftTitle = draft?.title;
  const draftContent = draft?.content;
  const sortedDocuments = useMemo(
    () => [...documents].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt)),
    [documents]
  );
  const documentGroups = useMemo(() => [
    {
      id: "mine" as const,
      label: "Created by me",
      shortLabel: "My documents",
      description: "Notes and drafts you started",
      items: sortedDocuments.filter((document) => documentGroupId(document) === "mine"),
    },
    {
      id: "agents" as const,
      label: "Agents",
      shortLabel: "Agents",
      description: "Work agents saved for review",
      items: sortedDocuments.filter((document) => documentGroupId(document) === "agents"),
    },
    {
      id: "handoffs" as const,
      label: "Handoffs",
      shortLabel: "Handoffs",
      description: "Context passed between tasks",
      items: sortedDocuments.filter((document) => documentGroupId(document) === "handoffs"),
    },
  ], [sortedDocuments]);
  const activeDocumentGroup = documentGroups.find((group) => group.id === activeGroup);
  const activeDocuments = activeDocumentGroup?.items ?? [];

  function updateDraft(next: Partial<DocumentDraft>) {
    if (!selected || !draft) return;
    setDrafts((current) => ({ ...current, [selected.id]: { ...draft, ...next } }));
  }

  function selectDocument(id: string | null) {
    setSelectedId(id);
    const next = documents.find((document) => document.id === id);
    if (next) setActiveGroup(documentGroupId(next));
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("document", id);
    else url.searchParams.delete("document");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function selectGroup(id: DocumentGroupId) {
    setActiveGroup(id);
    const firstDocument = documentGroups.find((group) => group.id === id)?.items[0];
    selectDocument(firstDocument?.id ?? null);
  }

  function updateDocumentContent(id: string, base: DocumentDraft, content: string) {
    setDrafts((current) => ({
      ...current,
      [id]: { ...(current[id] ?? base), content },
    }));
  }

  async function createDocument() {
    setError(null);
    const response = await fetch("/api/docs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Untitled document", content: "", kind: "user" }),
    });
    if (!response.ok) {
      setError("Could not create the document.");
      return;
    }
    const document = (await response.json()) as AgentDocument;
    setDocuments((current) => [document, ...current]);
    setActiveGroup("mine");
    selectDocument(document.id);
  }

  async function deleteDocument() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/docs/${deleteTarget.id}`, { method: "DELETE" });
    if (!response.ok) {
      setError("Could not delete the document.");
      setDeleting(false);
      return;
    }
    setDocuments((current) => current.filter((document) => document.id !== deleteTarget.id));
    setDrafts((current) => {
      const next = { ...current };
      delete next[deleteTarget.id];
      return next;
    });
    if (selectedId === deleteTarget.id) {
      const nextDocument = sortedDocuments.find((document) => document.id !== deleteTarget.id);
      selectDocument(nextDocument?.id ?? null);
    }
    setDeleteTarget(null);
    setDeleting(false);
  }

  useEffect(() => {
    if (!selectedDocumentId || !dirty || draftTitle === undefined || draftContent === undefined) return;
    const title = draftTitle.trim() || "Untitled document";
    const timer = window.setTimeout(() => {
      setSaving(true);
      setError(null);
      void fetch(`/api/docs/${selectedDocumentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: draftContent }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not save the document.");
          return response.json() as Promise<AgentDocument>;
        })
        .then((updated) => {
          setDocuments((current) =>
            current.map((document) => document.id === updated.id ? { ...document, ...updated } : document)
          );
          setDrafts((current) => {
            const currentDraft = current[selectedDocumentId];
            if (!currentDraft || currentDraft.title !== draftTitle || currentDraft.content !== draftContent) {
              return current;
            }
            const next = { ...current };
            delete next[selectedDocumentId];
            return next;
          });
        })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setSaving(false));
    }, 650);
    return () => window.clearTimeout(timer);
  }, [dirty, draftContent, draftTitle, selectedDocumentId]);

  return (
    <main className="flex h-full min-w-0 flex-col bg-deck">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-deck px-5 sm:px-6">
        <div>
          <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">Fleet output</p>
          <h1 className="mt-0.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">Documents</h1>
        </div>
        <span className="hidden font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint sm:block">{documents.length} saved</span>
        <button type="button" onClick={() => void createDocument()} className="ml-auto rounded-md bg-signal px-3 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:brightness-110">
          New doc
        </button>
      </header>

      {loading ? (
        <p className="p-6 font-mono text-xs text-ink-faint">Loading docs...</p>
      ) : documents.length === 0 ? (
        <div className="mx-auto mt-[16vh] max-w-lg border-l border-line-strong px-6 text-left">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-role-researcher">No saved documents</p>
          <h2 className="mt-4 text-3xl font-semibold tracking-[-0.035em] text-ink">Start a document or ask an agent to write one.</h2>
          <p className="mt-4 text-sm leading-7 text-ink-soft">Research briefs, plans, and written deliverables appear here. You can edit their Markdown directly.</p>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <nav aria-label="Document type" className="scrollbar-none shrink-0 overflow-x-auto border-b border-line bg-panel/40 px-4 sm:px-6">
            <div className="flex min-w-max gap-1">
              {documentGroups.map((group) => {
                const active = group.id === activeGroup;
                return (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => selectGroup(group.id)}
                    className={`relative flex items-center gap-2 px-3 py-3.5 text-left font-mono text-[9px] uppercase tracking-[0.13em] transition-colors ${active ? "text-ink" : "text-ink-faint hover:text-ink-soft"}`}
                    aria-current={active ? "page" : undefined}
                  >
                    <span>{group.label}</span>
                    <span className={`rounded-full px-1.5 py-0.5 text-[8px] tabular-nums ${active ? "bg-signal/15 text-signal" : "bg-panel-hi text-ink-faint"}`}>{group.items.length}</span>
                    {active && <span className="absolute inset-x-3 bottom-0 h-px bg-signal" />}
                  </button>
                );
              })}
            </div>
          </nav>

          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[256px_minmax(0,1fr)]">
            <aside className="scrollbar-none order-1 max-h-48 overflow-y-auto border-b border-line bg-panel/35 p-2 lg:order-none lg:max-h-none lg:border-b-0 lg:border-r lg:p-3">
              <div className="flex items-start justify-between gap-3 px-2 pb-3 pt-1">
                <div>
                  <p className="font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">{documentGroups.find((group) => group.id === activeGroup)?.shortLabel}</p>
                  <p className="mt-1 text-[11px] leading-4 text-ink-soft">{documentGroups.find((group) => group.id === activeGroup)?.description}</p>
                </div>
                <span className="pt-0.5 font-mono text-[9px] tabular-nums text-ink-faint">{activeDocuments.length}</span>
              </div>
              {activeDocuments.length > 0 ? activeDocuments.map((document) => (
                <button key={document.id} type="button" onClick={() => selectDocument(document.id)} className={`mb-1 block w-full rounded-md border px-3 py-3 text-left transition-colors ${document.id === selectedId ? "border-line-strong bg-panel-hi text-ink" : "border-transparent text-ink-soft hover:border-line hover:bg-panel-hi hover:text-ink"}`}>
                  <span className="line-clamp-2 text-xs font-semibold leading-snug">{drafts[document.id]?.title || document.title}</span>
                  <span className="mt-1.5 block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{document.authorRole === "user" ? "Edited by you" : roleLabel(document.authorRole)} / {new Date(document.updatedAt).toLocaleDateString()}</span>
                </button>
              )) : (
                <p className="px-2 py-5 text-xs leading-5 text-ink-faint">Nothing here yet.</p>
              )}
            </aside>

            {selected && draft ? (
              <section className="console-grid order-2 flex min-h-0 flex-col bg-deck lg:order-none">
                <div className="flex shrink-0 items-center gap-3 border-b border-line bg-deck/95 px-4 py-3 sm:px-6">
                <input value={draft.title} onChange={(event) => updateDraft({ title: event.target.value })} placeholder="Untitled document" className="min-w-0 flex-1 border-0 bg-transparent text-lg font-semibold tracking-[-0.025em] text-ink outline-none placeholder:text-ink-faint" />
                <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">
                  {saving ? "Saving..." : dirty ? "Unsaved" : "Saved"}
                </span>
                <button
                  type="button"
                  onClick={() => setDeleteTarget(selected)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-ink-faint transition-colors hover:bg-panel-hi hover:text-state-blocked focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong"
                  aria-label={`Delete ${draft.title || "document"}`}
                  title="Delete document"
                >
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3m-5.1 0 .55 8h5.7l.55-8M7 7v3.2m2-3.2v3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  <MarkdownDocumentEditor
                    key={selected.id}
                    value={draft.content}
                    onChange={(content) => updateDocumentContent(selected.id, pickDraft(selected), content)}
                  />
                </div>

                {error && <p className="shrink-0 border-t border-state-blocked/30 bg-state-blocked/[0.04] px-4 py-2 text-xs text-state-blocked">{error}</p>}
              </section>
            ) : (
              <section className="console-grid order-2 flex min-h-0 items-center bg-deck px-8 py-12 lg:order-none lg:px-16">
                <div className="max-w-md border-l border-line-strong pl-5">
                  <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">{activeDocumentGroup?.shortLabel}</p>
                  <h2 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-ink">Nothing saved here yet.</h2>
                  <p className="mt-3 text-sm leading-6 text-ink-soft">
                    {activeGroup === "mine" ? "Create a document to start writing." : activeDocumentGroup?.description}
                  </p>
                </div>
              </section>
            )}
          </div>
        </div>
      )}
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this document?"
        description={`"${deleteTarget?.title ?? "Untitled document"}" will be removed permanently.`}
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteDocument()}
      />
    </main>
  );
}

function pickDraft(document: AgentDocument): DocumentDraft {
  return { title: document.title, content: document.content };
}

function roleLabel(role: string): string {
  if (role === "squad-lead") return "Squad lead";
  if (role === "filer") return "Issue filer";
  return role.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function documentGroupId(document: AgentDocument): DocumentGroupId {
  if (document.kind === "handoff") return "handoffs";
  if (document.kind === "user" || document.authorRole === "user") return "mine";
  return "agents";
}
