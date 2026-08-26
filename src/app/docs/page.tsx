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

type DocumentGroupId = "all" | "mine" | "agents" | "handoffs";
type DocumentSort = "recent" | "oldest" | "title";

export default function DocsPage() {
  const [documents, setDocuments] = useState<AgentDocument[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DocumentDraft>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AgentDocument | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [activeGroup, setActiveGroup] = useState<DocumentGroupId>("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [sortBy, setSortBy] = useState<DocumentSort>("recent");

  useEffect(() => {
    void fetch("/api/docs", { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load documents.");
        return response.json() as Promise<AgentDocument[]>;
      })
      .then((items) => {
        setDocuments(items);
        const requestedId = new URLSearchParams(window.location.search).get("document");
        const initial = items.find((document) => document.id === requestedId);
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
      id: "all" as const,
      label: "All documents",
      shortLabel: "All documents",
      description: "Everything saved by you and the squad",
      items: sortedDocuments,
    },
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
  const visibleDocuments = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    const documentsInGroup = activeDocumentGroup?.items ?? [];
    const filtered = query
      ? documentsInGroup.filter((document) => {
        const currentDraft = drafts[document.id];
        return [
          currentDraft?.title ?? document.title,
          currentDraft?.content ?? document.content,
        document.mission?.title,
        document.task?.title,
        ].some((value) => value?.toLowerCase().includes(query));
      })
      : documentsInGroup;
    return [...filtered].sort((a, b) => {
      if (sortBy === "title") {
        return (drafts[a.id]?.title ?? a.title).localeCompare(drafts[b.id]?.title ?? b.title);
      }
      const direction = sortBy === "recent" ? -1 : 1;
      return direction * (+new Date(a.updatedAt) - +new Date(b.updatedAt));
    });
  }, [activeDocumentGroup, drafts, searchTerm, sortBy]);

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
    setSearchTerm("");
  }

  async function flushDraft(id: string): Promise<boolean> {
    const currentDraft = drafts[id];
    if (!currentDraft) return true;
    const title = currentDraft.title.trim() || "Untitled document";
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/docs/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: currentDraft.content }),
      });
      if (!response.ok) throw new Error("Could not save the document.");
      const updated = await response.json() as AgentDocument;
      setDocuments((current) => current.map((document) => document.id === updated.id ? { ...document, ...updated } : document));
      setDrafts((current) => {
        const latest = current[id];
        if (!latest || latest.title !== currentDraft.title || latest.content !== currentDraft.content) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function returnToLibrary() {
    if (selectedId && !await flushDraft(selectedId)) return;
    selectDocument(null);
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
      selectDocument(null);
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
      {loading ? (
        <p className="p-6 font-mono text-xs text-ink-faint">Loading docs...</p>
      ) : selected && draft ? (
        <section className="console-grid flex min-h-0 flex-1 flex-col bg-deck">
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-deck/95 px-4 py-3 sm:px-6">
            <button type="button" onClick={() => void returnToLibrary()} disabled={saving} className="flex h-8 shrink-0 items-center gap-2 rounded border border-line px-2.5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-soft transition-colors hover:border-line-strong hover:text-ink disabled:opacity-40" aria-label="Back to document library">
              <span aria-hidden="true">←</span> Library
            </button>
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
        <section className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px] px-5 py-8 sm:px-8 lg:px-12">
            <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-role-researcher">Fleet output / library</p>
                <h1 className="mt-3 text-3xl font-semibold tracking-[-0.04em] text-ink sm:text-4xl">Documents</h1>
                <p className="mt-3 text-sm leading-6 text-ink-soft">Research briefs, plans, and written deliverables from you and the squad.</p>
              </div>
              <button type="button" onClick={() => void createDocument()} className="self-start rounded-md bg-signal px-3.5 py-2.5 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-deck transition-colors hover:brightness-110 lg:self-auto">
                New doc
              </button>
            </header>

            {error && <p className="mt-6 rounded-md border border-state-blocked/40 bg-state-blocked/[0.05] px-3 py-2 text-xs text-state-blocked">{error}</p>}

            <div className="mt-8 flex flex-col gap-3 border-b border-line pb-4 xl:flex-row xl:items-center xl:justify-between">
              <nav aria-label="Document type" className="scrollbar-none overflow-x-auto">
                <div className="flex min-w-max gap-1">
                  {documentGroups.map((group) => {
                    const active = group.id === activeGroup;
                    return (
                      <button key={group.id} type="button" onClick={() => selectGroup(group.id)} className={`rounded-md px-3 py-2 text-left text-[11px] transition-colors ${active ? "bg-panel-hi text-ink" : "text-ink-faint hover:bg-panel hover:text-ink-soft"}`} aria-current={active ? "page" : undefined}>
                        {group.label}
                      </button>
                    );
                  })}
                </div>
              </nav>
              <div className="flex flex-col gap-3 sm:flex-row">
                <label className="flex min-w-0 items-center gap-2 rounded-md border border-line bg-panel/50 px-3 py-2 focus-within:border-line-strong sm:w-72">
                  <span className="text-ink-faint" aria-hidden="true">⌕</span>
                  <span className="sr-only">Search documents</span>
                  <input value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} placeholder="Search documents" className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint" />
                </label>
                <label className="flex items-center gap-2 rounded-md border border-line bg-panel/50 px-3 py-2 text-xs text-ink-soft">
                  <span className="font-mono text-[8px] uppercase tracking-[0.14em] text-ink-faint">Sort</span>
                  <select value={sortBy} onChange={(event) => setSortBy(event.target.value as DocumentSort)} className="bg-transparent text-xs text-ink outline-none">
                    <option value="recent">Recently edited</option>
                    <option value="oldest">Oldest first</option>
                    <option value="title">Title</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-between gap-4">
              <div>
                <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">{activeDocumentGroup?.shortLabel}</p>
                <p className="mt-1 text-xs text-ink-soft">{activeDocumentGroup?.description}</p>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">{visibleDocuments.length} {visibleDocuments.length === 1 ? "document" : "documents"}</span>
            </div>

            {visibleDocuments.length > 0 ? (
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                {visibleDocuments.map((document) => {
                  const currentDraft = drafts[document.id];
                  const title = currentDraft?.title || document.title;
                  const content = currentDraft?.content ?? document.content;
                  return (
                    <button key={document.id} type="button" onClick={() => selectDocument(document.id)} className="group flex min-h-56 flex-col rounded-lg border border-line bg-panel p-5 text-left transition-colors hover:border-line-strong hover:bg-panel-hi focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
                    <div className="flex items-start justify-between gap-4">
                      <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-ink-faint">{document.authorRole === "user" ? "Your document" : roleLabel(document.authorRole)}</span>
                      <span className="rounded bg-deck px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{document.kind === "handoff" ? "Handoff" : "Document"}</span>
                    </div>
                    <h2 className="mt-5 line-clamp-2 text-xl font-semibold tracking-[-0.03em] text-ink group-hover:text-signal">{title}</h2>
                    <p className="mt-3 line-clamp-3 flex-1 text-sm leading-6 text-ink-soft">{content.trim() ? previewText(content) : "No content yet. Open this document to start writing."}</p>
                    <div className="mt-6 flex items-center justify-between gap-3 border-t border-line pt-3 font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">
                      <span>{formatDocumentDate(document.updatedAt)}</span>
                      <span>{wordCount(content)} words</span>
                    </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-line bg-panel/40 px-6 py-12 text-center">
                <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-ink-faint">No matching documents</p>
                <p className="mt-3 text-sm text-ink-soft">Try a different search or create a new document.</p>
              </div>
            )}
          </div>
        </section>
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

function previewText(content: string): string {
  return content.replace(/[#>*_`~-]/g, "").replace(/\s+/g, " ").trim();
}

function wordCount(content: string): number {
  return content.trim() ? content.trim().split(/\s+/).length : 0;
}

function formatDocumentDate(value: string): string {
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function documentGroupId(document: AgentDocument): DocumentGroupId {
  if (document.kind === "handoff") return "handoffs";
  if (document.kind === "user" || document.authorRole === "user") return "mine";
  return "agents";
}
