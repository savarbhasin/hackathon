"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { ConfirmDialog } from "@/components/confirm-dialog";

interface PauseAction {
  type: string;
  threadId?: string | null;
  toolCallId: string;
  name?: string;
  question?: string;
  options?: string[];
  argsPreview?: string;
}

interface AnswerPayload {
  type: string;
  threadId?: string | null;
  toolCallId: string;
  content: string;
}

interface ChatEvent {
  kind: "conversation" | "delta" | "tool" | "status" | "pause" | "done";
  text?: string;
  name?: string;
  conversationId?: string;
  actions?: PauseAction[];
}

interface Msg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  tools?: string[];
  status?: string;
  pending?: boolean;
  pause?: PauseAction[];
}

interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: string;
  _count: { messages: number };
}

interface StoredConversation {
  id: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    tools: string;
    status: string | null;
    pauseActions: string | null;
  }>;
}

interface MentionableDocument {
  id: string;
  title: string;
  authorRole: string;
}

const EXAMPLE_REQUESTS = [
  "Research the top 3 vector databases of 2026 and save a comparison brief.",
  "What's on the board right now?",
  "Every weekday at 9am, check the board and summarize stuck tasks.",
];

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [documents, setDocuments] = useState<MentionableDocument[]>([]);
  const [attachedDocumentIds, setAttachedDocumentIds] = useState<string[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ConversationSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshConversations = useCallback(async () => {
    const res = await fetch("/api/conversations", { cache: "no-store" });
    if (res.ok) setConversations((await res.json()) as ConversationSummary[]);
  }, []);

  useEffect(() => {
    void refreshConversations();
  }, [refreshConversations]);

  useEffect(() => {
    if (!historyOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [historyOpen]);

  const scrollDown = () =>
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 50);

  async function loadConversation(id: string) {
    if (busy || id === conversationId) return;
    setLoadingConversation(true);
    try {
      const res = await fetch(`/api/conversations/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const stored = (await res.json()) as StoredConversation;
      setConversationId(stored.id);
      setMessages(
        stored.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => ({
            id: message.id,
            role: message.role as Msg["role"],
            content: message.content,
            tools: parseTools(message.tools),
            status: message.status ?? undefined,
            pause: parsePauseActions(message.pauseActions),
          }))
      );
      setHistoryOpen(false);
      scrollDown();
    } finally {
      setLoadingConversation(false);
    }
  }

  function newConversation() {
    if (busy) return;
    setConversationId(null);
    setMessages([]);
    setInput("");
    setHistoryOpen(false);
  }

  async function deleteConversation() {
    if (!deleteTarget || busy || loadingConversation || deleting) return;
    setDeleting(true);
    const response = await fetch(`/api/conversations/${deleteTarget.id}`, { method: "DELETE" });
    if (!response.ok) {
      setDeleting(false);
      return;
    }
    setConversations((current) => current.filter((conversation) => conversation.id !== deleteTarget.id));
    if (conversationId === deleteTarget.id) {
      setConversationId(null);
      setMessages([]);
      setInput("");
    }
    setDeleteTarget(null);
    setDeleting(false);
  }

  async function runTurn(body: Record<string, unknown>, userBubble?: string) {
    if (busy || loadingConversation) return;
    setBusy(true);
    setMessages((current) => [
      ...current,
      ...(userBubble !== undefined
        ? [{ role: "user" as const, content: userBubble }]
        : []),
      { role: "assistant", content: "", tools: [], pending: true },
    ]);
    scrollDown();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok || !res.body) throw new Error(`chat request failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          handleEvent(JSON.parse(payload) as ChatEvent);
        }
      }
    } catch (error) {
      setMessages((current) => {
        const copy = [...current];
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          pending: false,
          content: `Connection error: ${String(error).slice(0, 200)}`,
        };
        return copy;
      });
    } finally {
      setBusy(false);
      await refreshConversations();
      scrollDown();
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy || loadingConversation) return;
    setInput("");
    await runTurn({ message: text, conversationId }, text);
  }

  async function answer(answers: AnswerPayload[]) {
    if (!conversationId || busy) return;
    setMessages((current) => current.map((message) => ({ ...message, pause: undefined })));
    await runTurn({ answers, conversationId }, answers.map((a) => a.content).join(" · "));
  }

  function handleEvent(event: ChatEvent) {
    if (event.kind === "conversation" && event.conversationId) {
      setConversationId(event.conversationId);
      return;
    }

    setMessages((current) => {
      const copy = [...current];
      const last = { ...copy[copy.length - 1] };
      switch (event.kind) {
        case "delta":
          last.content += event.text ?? "";
          break;
        case "tool":
          last.tools = [...(last.tools ?? []), event.name ?? "unknown tool"];
          break;
        case "status":
          last.status = event.text ?? undefined;
          break;
        case "pause":
          last.pause = event.actions ?? [];
          last.pending = false;
          break;
        case "done":
          if (!last.content && event.text) last.content = event.text;
          last.pending = false;
          break;
      }
      copy[copy.length - 1] = last;
      return copy;
    });
    scrollDown();
  }

  return (
    <main className="relative flex h-full min-w-0 bg-deck">
      <section className="console-grid relative flex min-w-0 flex-1 flex-col">
        <button
          type="button"
          onClick={() => setHistoryOpen(true)}
          className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-md border border-line-strong bg-panel text-ink-soft shadow-lg transition-colors hover:text-ink lg:hidden"
          aria-label="Open conversations"
        >
          <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true"><path d="M3.5 4.5h11v8H8l-3 2v-2H3.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M6.5 7h5M6.5 9.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
        </button>

        <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
          {loadingConversation ? (
            <p className="mx-auto mt-[20vh] max-w-2xl font-mono text-xs text-ink-faint">Loading command history...</p>
          ) : messages.length === 0 ? (
            <EmptyState onPick={setInput} />
          ) : null}

          <div className="mx-auto max-w-3xl space-y-7">
            {messages.map((message, index) => (
              <Message key={message.id ?? index} message={message} onAnswer={(a) => void answer(a)} />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>

        <footer className="bg-deck/90 p-3 backdrop-blur sm:p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
            className="signal-glow mx-auto flex max-w-3xl flex-col rounded-2xl border border-line-strong bg-panel-hi px-4 pb-3 pt-3 focus-within:border-signal/60"
          >
            <label htmlFor="mission-input" className="sr-only">Assign work</label>
            <textarea
              id="mission-input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              placeholder={busy ? "The fleet is working..." : "Assign work or ask a follow-up"}
              disabled={busy || loadingConversation}
              rows={2}
              className="scrollbar-none min-h-[58px] w-full resize-none border-0 bg-transparent text-sm leading-6 text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
            />
            <div className="flex items-center gap-3">
              <span className="text-[10px] text-ink-faint">Enter to send</span>
              <span className="text-[10px] text-ink-faint">Shift + Enter for a new line</span>
              <button
                type="submit"
                disabled={busy || loadingConversation || !input.trim()}
                className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal text-deck transition-transform hover:scale-[1.03] disabled:opacity-25"
                aria-label="Send request"
              >
                <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true"><path d="m4 10 11-6-3.3 12-2-4.2L4 10Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="m9.7 11.8 2-2.2" stroke="currentColor" strokeWidth="1.6" /></svg>
              </button>
            </div>
          </form>
        </footer>
      </section>

      <aside className="hidden w-[286px] shrink-0 flex-col border-l border-line bg-panel/70 lg:flex">
        <SideContent
          conversations={conversations}
          activeId={conversationId}
          busy={busy}
          onNew={newConversation}
          onSelect={(id) => void loadConversation(id)}
          onDelete={setDeleteTarget}
        />
      </aside>

      {historyOpen && (
        <div
          className="absolute inset-0 z-40 flex justify-end bg-black/60 backdrop-blur-[2px] lg:hidden"
          onClick={() => setHistoryOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Conversations"
        >
          <aside
            className="flex h-full w-[min(330px,calc(100%-28px))] flex-col border-l border-line bg-panel shadow-[-24px_0_60px_rgba(0,0,0,.4)]"
            onClick={(event) => event.stopPropagation()}
          >
            <SideContent
              conversations={conversations}
              activeId={conversationId}
              busy={busy}
              onClose={() => setHistoryOpen(false)}
              onNew={newConversation}
              onSelect={(id) => void loadConversation(id)}
              onDelete={setDeleteTarget}
            />
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Delete this chat?"
        description={`"${deleteTarget?.title ?? "This chat"}" and all of its messages will be removed permanently.`}
        busy={deleting}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void deleteConversation()}
      />

    </main>
  );
}

function SideContent({
  conversations,
  activeId,
  busy,
  onNew,
  onSelect,
  onDelete,
  onClose,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  busy: boolean;
  onNew: () => void;
  onSelect: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex h-16 shrink-0 items-center gap-1 border-b border-line px-3">
        <span className="px-2 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-faint">Conversations</span>
        <button
          onClick={onNew}
          disabled={busy}
          className="ml-auto rounded-md border border-line-strong bg-panel-hi px-2.5 py-1.5 text-[11px] font-semibold text-ink transition-colors hover:border-ink-faint disabled:opacity-40"
        >
          Chat <span aria-hidden="true" className="ml-1 text-signal">+</span>
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-line text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
            aria-label="Close panel"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
          </button>
        )}
      </div>
      <div className="scrollbar-none min-h-0 flex-1 overflow-y-auto p-3">
        <ConversationList
          conversations={conversations}
          activeId={activeId}
          disabled={busy}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      </div>
    </>
  );
}

function ConversationList({
  conversations,
  activeId,
  disabled,
  onSelect,
  onDelete,
}: {
  conversations: ConversationSummary[];
  activeId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onDelete: (conversation: ConversationSummary) => void;
}) {
  if (conversations.length === 0) {
    return <p className="px-2 py-4 text-xs leading-relaxed text-ink-faint">Past commands will appear here.</p>;
  }
  const groups = groupConversations(conversations);
  return groups.map((group) => (
    <details key={group.label} open className="group mb-3">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 12 12" className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {group.label}
        <span className="ml-auto tabular-nums">{group.items.length}</span>
      </summary>
      <div className="mt-1 space-y-1">
        {group.items.map((conversation) => (
          <div
            key={conversation.id}
            className={`group flex items-center gap-1 rounded-md transition-colors ${
              activeId === conversation.id ? "bg-panel-hi text-ink" : "text-ink-soft hover:bg-panel-hi hover:text-ink"
            }`}
          >
            <button
              onClick={() => onSelect(conversation.id)}
              disabled={disabled}
              className="min-w-0 flex-1 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong disabled:opacity-50"
            >
              <span className="line-clamp-2 text-xs font-medium leading-snug">{conversation.title}</span>
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onDelete(conversation)}
              className="mr-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-ink-faint opacity-0 transition-colors hover:bg-deck hover:text-state-blocked focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line-strong disabled:opacity-40 group-hover:opacity-100 group-focus-within:opacity-100"
              aria-label={`Delete ${conversation.title}`}
              title="Delete conversation"
            >
              <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="M3.5 4.5h9M6.2 4.5V3.2h3.6v1.3m-5.1 0 .55 8h5.7l.55-8M7 7v3.2m2-3.2v3.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>
        ))}
      </div>
    </details>
  ));
}

function groupConversations(conversations: ConversationSummary[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  const groups = [
    { label: "Today", items: [] as ConversationSummary[] },
    { label: "Yesterday", items: [] as ConversationSummary[] },
    { label: "Past week", items: [] as ConversationSummary[] },
  ];

  for (const conversation of conversations) {
    const updated = new Date(conversation.updatedAt);
    if (updated >= today) groups[0].items.push(conversation);
    else if (updated >= yesterday) groups[1].items.push(conversation);
    else groups[2].items.push(conversation);
  }

  return groups.filter((group) => group.items.length > 0);
}

interface HeroCopy {
  eyebrow: string;
  heading: string;
}

const DEFAULT_HERO: HeroCopy = {
  eyebrow: "Ready when you are",
  heading: "What are we getting done?",
};

function heroCopyForHour(hour: number): HeroCopy {
  if (hour < 5) return { eyebrow: "After hours", heading: "Burning the midnight oil?" };
  if (hour < 9) return { eyebrow: "Early start", heading: "Up early. What are we getting done?" };
  if (hour < 12) return { eyebrow: "Morning shift", heading: "What should we knock out this morning?" };
  if (hour < 17) return { eyebrow: "Afternoon run", heading: "What's next on the worklist?" };
  if (hour < 21) return { eyebrow: "Evening push", heading: "One more thing off the list?" };
  return { eyebrow: "Late shift", heading: "Up for a late-night jam session?" };
}

function EmptyState({ onPick }: { onPick: (value: string) => void }) {
  const [hero, setHero] = useState<HeroCopy>(DEFAULT_HERO);

  useEffect(() => {
    const syncToClock = () => setHero(heroCopyForHour(new Date().getHours()));
    syncToClock();
    const timer = window.setInterval(syncToClock, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="mx-auto mt-[4vh] max-w-3xl sm:mt-[6vh]">
      <div className="flex items-center gap-3">
        <span className="h-px w-8 bg-signal" />
        <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-signal">{hero.eyebrow}</p>
      </div>
      <h1 className="mt-4 max-w-2xl font-display text-[clamp(1.7rem,3.6vw,3rem)] font-extrabold leading-[1.02] tracking-[-0.04em] text-ink">{hero.heading}</h1>
      <p className="mt-4 max-w-lg text-sm leading-6 text-ink-soft">
        Brief the squad. It will break the work into tasks, run them in parallel,
        and pause before anything irreversible.
      </p>
      <div className="relative mt-6 space-y-1 pl-5 before:absolute before:bottom-4 before:left-[3px] before:top-4 before:w-px before:bg-line">
        <p className="mb-3 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-faint">Try a request</p>
        {EXAMPLE_REQUESTS.map((request) => (
          <button
            key={request}
            onClick={() => onPick(request)}
            className="group relative flex w-full items-start gap-3 rounded-md px-3 py-3 text-left text-ink-soft transition-colors hover:bg-panel-hi hover:text-ink"
          >
            <span aria-hidden="true" className="absolute left-[-21px] top-[18px] h-[7px] w-[7px] rounded-full border border-line-strong bg-deck transition-colors group-hover:border-signal group-hover:bg-signal" />
            <span className="text-[13px] leading-relaxed">{request}</span>
            <svg viewBox="0 0 16 16" className="ml-auto mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint transition-all group-hover:translate-x-0.5 group-hover:text-signal" aria-hidden="true"><path d="M4 12 12 4m-5 0h5v5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        ))}
      </div>
    </div>
  );
}

function Message({ message, onAnswer }: { message: Msg; onAnswer?: (answers: AnswerPayload[]) => void }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] text-right">
          <p className="mb-1 font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">You</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative pl-6 before:absolute before:bottom-0 before:left-[3px] before:top-0 before:w-px before:bg-line">
      <span aria-hidden="true" className={`absolute left-0 top-1.5 h-[7px] w-[7px] rounded-full ${message.pending ? "bg-signal led-live" : message.pause?.length ? "border border-state-blocked bg-state-blocked/30" : "border border-line bg-deck"}`} />
      <p className="mb-2 flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.2em] text-state-working">
        Squad Lead
        {message.pending && <span className="text-ink-faint">working</span>}
        {!message.pending && message.pause?.length ? <span className="text-state-blocked">paused, input needed</span> : null}
      </p>
      {(message.tools?.length ?? 0) > 0 && (
        <ToolActivity tools={message.tools!} active={Boolean(message.pending)} />
      )}
      {message.content ? <ChatMarkdown>{message.content}</ChatMarkdown> : !message.pause?.length && <span className={`inline-block ${message.pending ? "h-4 w-28 animate-pulse rounded bg-panel-hi" : ""}`} />}
      {!message.pending && (message.pause?.length ?? 0) > 0 && onAnswer && (
        <PauseBlock actions={message.pause!} busy={false} onAnswer={onAnswer} />
      )}
      {message.status && !message.pending && (
        <div className="mt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-ink-faint">{message.status}</div>
      )}
    </div>
  );
}

function ToolActivity({ tools, active }: { tools: string[]; active: boolean }) {
  const latest = tools[tools.length - 1];
  const extra = tools.length > 1 ? ` + ${tools.length - 1}` : "";
  return (
    <details className="group mb-3 max-w-xl">
      <summary className="flex list-none items-center gap-1.5 font-mono text-[10px] leading-relaxed text-ink-faint [&::-webkit-details-marker]:hidden">
        <span className={`min-w-0 truncate ${active ? "tool-activity-live" : ""}`}>{toolActivityLabel(latest, active)}{extra}</span>
        <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-ink-faint transition-transform group-open:rotate-90" aria-hidden="true">
          <path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      <div className="mt-1.5 border-l border-line pl-3">
        <ol className="space-y-1.5">
          {tools.map((tool, index) => (
            <li key={`${tool}-${index}`} className="flex items-start gap-2 font-mono text-[10px] leading-relaxed text-ink-soft">
              <span className="w-4 shrink-0 text-right tabular-nums text-ink-faint">{index + 1}</span>
              <code className="break-all">{tool}</code>
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

const TOOL_ACTIVITY: Record<string, { active: string; done: string }> = {
  list_tools: { active: "Checking available actions", done: "Checked available actions" },
  get_tool_info: { active: "Reading action details", done: "Read action details" },
  call_tool: { active: "Using a connected service", done: "Used a connected service" },
  list_board: { active: "Checking the fleet", done: "Checked the fleet" },
  list_agents: { active: "Finding the right agent", done: "Found available agents" },
  get_task: { active: "Reading task details", done: "Read task details" },
  create_mission: { active: "Creating a task group", done: "Created a task group" },
  create_task: { active: "Adding work to the board", done: "Added work to the board" },
  dispatch_task: { active: "Starting an agent", done: "Started an agent" },
  dispatch_ready: { active: "Starting ready agents", done: "Started ready agents" },
  create_schedule: { active: "Creating a schedule", done: "Created a schedule" },
  list_schedules: { active: "Checking schedules", done: "Checked schedules" },
  cancel_schedule: { active: "Cancelling a schedule", done: "Cancelled a schedule" },
  list_docs: { active: "Checking saved documents", done: "Checked saved documents" },
  get_doc: { active: "Reading a document", done: "Read a document" },
  save_document: { active: "Saving a document", done: "Saved a document" },
};

function toolActivityLabel(tool: string, active: boolean): string {
  const base = tool.split(".").pop() ?? tool;
  const known = TOOL_ACTIVITY[base];
  if (known) return active ? known.active : known.done;
  const readable = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return `${active ? "Using" : "Used"} ${readable || "a tool"}`;
}

function PauseBlock({
  actions,
  busy,
  onAnswer,
}: {
  actions: PauseAction[];
  busy: boolean;
  onAnswer: (answers: AnswerPayload[]) => void;
}) {
  return (
    <div className="mt-3 max-w-xl space-y-3">
      {actions.map((action) => (
        <PauseActionCard key={action.toolCallId} action={action} busy={busy} onAnswer={onAnswer} />
      ))}
    </div>
  );
}

function PauseActionCard({
  action,
  busy,
  onAnswer,
}: {
  action: PauseAction;
  busy: boolean;
  onAnswer: (answers: AnswerPayload[]) => void;
}) {
  const [custom, setCustom] = useState("");

  const submit = (content: string) => {
    if (!content.trim() || busy) return;
    onAnswer([{ type: action.type, threadId: action.threadId, toolCallId: action.toolCallId, content: content.trim() }]);
  };

  const isQuestion = Boolean(action.question);
  return (
    <div className={`rounded-lg border p-4 ${isQuestion ? "border-line-strong bg-panel-hi" : "border-signal/50 bg-signal/5"}`}>
      <p className={`mb-1 font-mono text-[8px] uppercase tracking-[0.2em] ${isQuestion ? "text-state-blocked" : "text-signal"}`}>
        {isQuestion ? "Orchestrator asks" : `Paused · ${action.type}`}
      </p>
      {action.question && (
        <p className="mb-3 text-sm leading-relaxed text-ink">{action.question}</p>
      )}
      {!isQuestion && (
        <pre className="mb-3 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded border border-line bg-deck p-2 font-mono text-[10px] text-ink-faint">
          {action.argsPreview}
        </pre>
      )}
      {(action.options?.length ?? 0) > 0 && (
        <div className="mb-2 space-y-1.5">
          {action.options?.map((option) => (
            <button
              key={option}
              onClick={() => submit(option)}
              disabled={busy}
              className="block w-full rounded-md border border-line-strong bg-panel px-3 py-2 text-left text-xs leading-snug text-ink transition-colors hover:border-signal hover:bg-signal/10 disabled:opacity-40"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(custom);
          setCustom("");
        }}
        className="flex gap-2"
      >
        <input
          value={custom}
          onChange={(event) => setCustom(event.target.value)}
          placeholder="Or type your own answer…"
          disabled={busy}
          className="min-w-0 flex-1 rounded-md border border-line bg-deck px-2.5 py-1.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-line-strong disabled:opacity-40"
        />
        <button
          type="submit"
          disabled={busy || !custom.trim()}
          className="rounded-md bg-signal px-3 py-1.5 text-[11px] font-semibold text-deck transition-transform hover:scale-[1.02] disabled:opacity-25"
        >
          Reply
        </button>
      </form>
    </div>
  );
}

function parseTools(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parsePauseActions(raw: string | null): PauseAction[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PauseAction[]) : undefined;
  } catch {
    return undefined;
  }
}
