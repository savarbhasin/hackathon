"use client";

import { useCallback, useEffect, useState } from "react";

interface Task {
  id: string;
  missionId: string;
  title: string;
  detail: string | null;
  role: string;
  agentPrompt: string | null;
  column: string;
  sessionId: string | null;
  dependsOn: string;
  handoff: string | null;
  output: string | null;
  error: string | null;
  pendingActions?: string | null;
  createdAt: string;
  updatedAt: string;
  predecessors?: Array<{ id: string; title: string; column: string }>;
}

interface Mission {
  id: string;
  title: string;
  goal: string;
  status: string;
  createdAt: string;
  tasks: Task[];
}

const COLUMNS = [
  { key: "backlog", label: "Backlog", rail: "bg-state-backlog", text: "text-state-backlog" },
  { key: "working", label: "Working", rail: "bg-state-working", text: "text-state-working" },
  { key: "blocked", label: "Blocked", rail: "bg-state-blocked", text: "text-state-blocked" },
  { key: "approval", label: "Needs approval", rail: "bg-state-approval", text: "text-state-approval" },
  { key: "settled", label: "Settled", rail: "bg-state-settled", text: "text-state-settled" },
] as const;

const COLUMN_TEXT: Record<string, string> = Object.fromEntries(
  COLUMNS.map((c) => [c.key, c.text])
);

export default function Board() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      setConnected(true);
      try {
        setMissions(JSON.parse(e.data));
      } catch {
        /* partial */
      }
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const activeCount = missions.reduce(
    (count, mission) => count + mission.tasks.filter((task) => task.column === "working").length,
    0
  );

  return (
    <main className="flex h-full flex-col bg-deck">
      <header className="flex h-16 shrink-0 items-center gap-5 border-b border-line bg-deck px-5 sm:px-6">
        <div>
          <p className="font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">Live operations</p>
          <h1 className="mt-0.5 text-[15px] font-semibold tracking-[-0.02em] text-ink">Agent fleet</h1>
        </div>
        <div className="hidden items-center gap-5 border-l border-line pl-5 font-mono text-[9px] uppercase tracking-[0.12em] text-ink-faint sm:flex">
          <span><b className="font-medium text-state-working">{activeCount}</b> running</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className={`hidden items-center gap-1.5 font-mono text-[9px] uppercase tracking-[0.16em] sm:flex ${connected ? "text-state-settled" : "text-state-blocked"}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-state-settled led-live" : "bg-signal"}`} />
            {connected ? "Live" : "Reconnecting"}
          </span>
        </div>
      </header>

      <div className="console-grid min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-[1080px]">
          {COLUMNS.map((col) => {
              const tasks = missions.flatMap((m) =>
                m.tasks.filter((t) => t.column === col.key)
              );
              const isGate = col.key === "approval";
              const pausedStateHint = pausedStateHintFor(col.key);
              return (
                <section
                  key={col.key}
                  className={`flex min-h-0 min-w-0 flex-1 flex-col ${isGate ? "bg-state-blocked/[0.025]" : ""} border-l border-line first:border-l-0`}
                >
                  <div className={`h-px shrink-0 opacity-80 ${col.rail}`} />
                  <div
                    className="group/state relative flex h-11 shrink-0 items-center gap-2 border-b border-line bg-deck/70 px-3 backdrop-blur-sm"
                    tabIndex={pausedStateHint ? 0 : undefined}
                  >
                    <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${col.rail}`} />
                    <h2
                      className={`truncate whitespace-nowrap font-mono text-[9px] font-medium uppercase tracking-[0.16em] ${col.text}`}
                    >
                      {col.label}
                    </h2>
                    <span className="ml-auto font-mono text-[9px] tabular-nums text-ink-faint">
                      {tasks.length}
                    </span>
                    {pausedStateHint && (
                      <p
                        role="tooltip"
                        className="pointer-events-none absolute left-2 top-full z-30 w-64 translate-y-1 rounded-md border border-line-strong bg-panel p-3 text-[11px] leading-relaxed text-ink-soft opacity-0 shadow-2xl transition-opacity group-hover/state:opacity-100 group-focus/state:opacity-100"
                      >
                        {pausedStateHint}
                      </p>
                    )}
                  </div>

                  <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
                    <StateTaskGroups tasks={tasks} now={now} onSelect={setSelected} />
                  </div>
                </section>
              );
          })}
        </div>
      </div>

      {selected && <Drawer taskId={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

function StateTaskGroups({
  tasks,
  now,
  onSelect,
}: {
  tasks: Task[];
  now: number;
  onSelect: (taskId: string) => void;
}) {
  const [today, ...olderGroups] = groupTasksByDate(tasks, now);

  if (tasks.length === 0) {
    return <p className="py-6 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Empty</p>;
  }

  return (
    <div className="space-y-2">
      {today.tasks.map((task) => (
        <Card key={task.id} task={task} now={now} onClick={() => onSelect(task.id)} />
      ))}

      {today.tasks.length === 0 && (
        <p className="py-3 text-center font-mono text-[8px] uppercase tracking-[0.14em] text-ink-faint">No tasks today</p>
      )}

      {olderGroups.filter((group) => group.tasks.length > 0).map((group) => (
        <TaskDateGroup key={group.label} group={group} now={now} onSelect={onSelect} />
      ))}
    </div>
  );
}

function Card({
  task,
  now,
  onClick,
}: {
  task: Task;
  now: number;
  onClick: () => void;
}) {
  const gated = task.column === "approval";
  const toolName = gated ? firstPendingTool(task.pendingActions) : null;
  const dependencyCount = safeDependencyCount(task.dependsOn);

  return (
    <button
      onClick={onClick}
      className="group block w-full rounded-md border border-line bg-panel p-3.5 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal hover:border-line-strong hover:bg-panel-hi"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="agent-role font-mono text-[9px] font-bold uppercase tracking-[0.12em]">
          {roleLabel(task.role)}
        </span>
        <span className="ml-auto font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">
          {relativeTime(task.updatedAt, now)}
        </span>
      </div>

      <p className="font-sans text-[13px] font-medium leading-snug text-ink">{task.title}</p>

      {dependencyCount > 0 && (
        <p className="mt-3 border-t border-line/70 pt-2.5 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">
          {dependencyCount} {dependencyCount === 1 ? "dependency" : "dependencies"}
        </p>
      )}

      {gated && (
        <p className="mt-3 font-mono text-[8px] font-medium uppercase tracking-[0.14em] text-state-approval">
          Approval required{toolName ? ` / ${toolName}` : ""}
        </p>
      )}
      {task.error && (
        <p className="mt-1 line-clamp-2 font-mono text-[10px] leading-relaxed text-state-blocked">
          {task.error}
        </p>
      )}
    </button>
  );
}

function TaskDateGroup({
  group,
  now,
  onSelect,
}: {
  group: { label: string; tasks: Task[] };
  now: number;
  onSelect: (taskId: string) => void;
}) {
  const initiallyOpen = group.label === "Yesterday" || group.label === "Past week";
  const [open, setOpen] = useState(initiallyOpen);
  const cards = (
    <div className="space-y-2">
      {group.tasks.map((task) => (
        <Card key={task.id} task={task} now={now} onClick={() => onSelect(task.id)} />
      ))}
    </div>
  );

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="group mt-3"
    >
      <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-1 font-mono text-[8px] font-medium uppercase tracking-[0.14em] text-ink-faint transition-colors hover:text-ink [&::-webkit-details-marker]:hidden">
        <svg viewBox="0 0 12 12" className="h-3 w-3 transition-transform group-open:rotate-90" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" /></svg>
        {group.label}
        <span className="ml-auto tabular-nums">{group.tasks.length}</span>
      </summary>
      <div className="mt-2">{cards}</div>
    </details>
  );
}

interface TaskEvent {
  id: string;
  seq: number;
  type: string;
  payload: string;
  createdAt: string;
}

function Drawer({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [task, setTask] = useState<(Task & { events: TaskEvent[] }) | null>(null);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const fetchTask = useCallback(async (): Promise<(Task & { events: TaskEvent[] }) | null> => {
    const res = await fetch(`/api/tasks/${taskId}`);
    return res.ok ? ((await res.json()) as Task & { events: TaskEvent[] }) : null;
  }, [taskId]);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      void fetchTask().then((data) => {
        if (alive && data) setTask(data);
      });
    poll();
    const t = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [fetchTask]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await new Promise((r) => setTimeout(r, 500));
      const data = await fetchTask();
      if (data) setTask(data);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pendingCalls = safeParseActions(task?.pendingActions);

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/70 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <aside
        className="scrollbar-none flex w-full max-w-[520px] flex-col overflow-y-auto border-l border-line bg-panel p-5 shadow-[-18px_0_50px_rgba(0,0,0,0.4)] sm:p-6"
        onClick={(e) => e.stopPropagation()}
      >
        {!task ? (
          <p className="font-mono text-xs text-ink-soft">Loading task...</p>
        ) : (
          <>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="flex items-center gap-2 pt-0.5">
                <span className="agent-role font-mono text-[9px] font-bold uppercase tracking-[0.12em]">
                  {roleLabel(task.role)}
                </span>
              </div>
              <button
                onClick={onClose}
                aria-label="Close task details"
                  className="flex h-8 w-8 items-center justify-center rounded-md border border-line font-mono text-sm text-ink-soft transition-colors hover:border-line-strong hover:bg-panel-hi hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
              </button>
            </div>

            <h3 className="font-sans text-xl font-semibold leading-snug tracking-[-0.025em] text-ink">
              {task.title}
            </h3>

            {task.detail && (
              <p className="mt-4 whitespace-pre-wrap border-l border-line-strong pl-4 text-xs leading-relaxed text-ink-soft">
                {task.detail}
              </p>
            )}
            {task.agentPrompt && (
              <details className="mt-4 rounded-md border border-line bg-deck/40 p-3">
                <summary className="cursor-pointer font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-ink-soft">
                  Agent instructions
                </summary>
                <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                  {task.agentPrompt}
                </p>
              </details>
            )}
            {task.error && (
              <p className="mt-4 rounded-md border border-state-blocked/30 bg-state-blocked/[0.04] p-3 font-mono text-xs leading-relaxed text-state-blocked">
                {task.error}
              </p>
            )}

            {pendingCalls.map((a) =>
              a.calls.map((call) => (
                <section
                  key={call.id}
                  className="relative mt-5 overflow-hidden rounded-md border border-state-blocked/40 bg-state-blocked/[0.035]"
                >
                  <span className="absolute inset-y-0 left-0 w-px bg-state-blocked" />
                  <div className="p-3 pl-4">
                    <p className="font-mono text-[9px] font-medium uppercase tracking-[0.16em] text-state-blocked">
                      {a.type === "tool.approval_required" ? "Irreversible action" : "Agent question"}
                      {call.name ? ` / ${call.name}` : ""}
                    </p>
                    {call.args && (
                      <pre className="mt-3 max-h-44 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-line bg-deck p-3 font-mono text-[10px] leading-relaxed text-ink-soft">
                        {prettyArgs(call.args)}
                      </pre>
                    )}
                    {a.type === "tool.approval_required" ? (
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <button
                          disabled={busy}
                          onClick={() => act({ action: "approve", allow: true })}
                          className="rounded-md bg-ink px-3 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-deck transition-colors hover:bg-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                        >
                          Approve
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => act({ action: "approve", allow: false, reason: "denied from board" })}
                          className="rounded-md border border-line-strong bg-transparent px-3 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-ink-soft transition-colors hover:border-ink-faint hover:text-ink disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                        >
                          Deny
                        </button>
                      </div>
                    ) : (
                      <form
                        className="mt-3 flex gap-2"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (!answer.trim()) return;
                          void act({ action: "answer", content: answer.trim() });
                          setAnswer("");
                        }}
                      >
                        <input
                          value={answer}
                          onChange={(e) => setAnswer(e.target.value)}
                          placeholder="Your answer"
                          className="min-w-0 flex-1 rounded-md border border-line-strong bg-deck px-2.5 py-2.5 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-signal"
                        />
                        <button
                          disabled={busy || !answer.trim()}
                          className="rounded-md bg-signal px-3 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-deck transition-colors hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
                        >
                          Reply
                        </button>
                      </form>
                    )}
                  </div>
                </section>
              ))
            )}

            {task.column === "backlog" && (
              <button
                disabled={busy}
                onClick={() => act({ action: "dispatch" })}
                className="mt-5 rounded-md bg-signal px-3 py-2.5 font-mono text-[10px] font-medium uppercase tracking-[0.15em] text-deck transition-colors hover:brightness-110 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal"
              >
                Dispatch now
              </button>
            )}

            {(task.handoff || task.output) && task.column === "settled" && (
              <div className="mt-5 rounded-md border border-line bg-deck/40 p-4">
                <p className="font-mono text-[8px] font-medium uppercase tracking-[0.16em] text-ink-faint">
                  Result
                </p>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                  {task.handoff ?? task.output}
                </p>
              </div>
            )}

            {task.predecessors && task.predecessors.length > 0 && (
              <section className="mt-6">
                <h4 className="mb-1.5 font-mono text-[9px] font-semibold uppercase tracking-[0.22em] text-ink-faint">
                  Predecessors
                </h4>
                <ul className="space-y-1">
                  {task.predecessors.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center gap-2.5 rounded-md border border-line bg-deck/40 px-3 py-2"
                    >
                      <span
                        className={`shrink-0 font-mono text-[9px] font-semibold uppercase tracking-[0.14em] ${
                          COLUMN_TEXT[p.column] ?? "text-ink-soft"
                        }`}
                      >
                        {p.column}
                      </span>
                      <span className="truncate text-xs font-medium text-ink">{p.title}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="mt-7 border-t border-line">
              <button
                onClick={() => setShowLog((v) => !v)}
                aria-expanded={showLog}
                className="flex w-full items-center gap-2 px-1 py-3 font-mono text-[8px] font-medium uppercase tracking-[0.2em] text-ink-faint transition-colors hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
              >
                <span
                  aria-hidden="true"
                  className={`inline-block transition-transform duration-100 ${showLog ? "rotate-90" : ""}`}
                >
                  ›
                </span>
                Event log
                <span className="ml-auto tabular-nums">{task.events.length}</span>
              </button>
              {showLog && (
                <div className="pb-8">
                  {[...task.events].reverse().map((e) => (
                    <details key={e.id} className="group border-t border-line/60 first:border-t-0">
                      <summary className="cursor-pointer list-none px-1 py-1.5 font-mono text-[10px] text-ink-soft transition-colors hover:bg-panel-hi hover:text-ink focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal">
                        <span className="tabular-nums text-ink-faint">
                          {new Date(e.createdAt).toLocaleTimeString()}{" "}
                        </span>
                        <span className="mr-1 text-[8px] uppercase tracking-[0.1em] text-ink-faint">{eventLabel(e.type)}</span>
                        {e.type}
                      </summary>
                      <pre className="mx-1 mb-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-line bg-deck p-2.5 font-mono text-[10px] leading-relaxed text-ink-soft">
                        {prettyPayload(e.payload)}
                      </pre>
                    </details>
                  ))}
                  {task.events.length === 0 && (
                    <p className="px-1 py-2 font-mono text-[10px] text-ink-faint">No events yet</p>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </aside>
    </div>
  );
}

function safeParseActions(raw: string | null | undefined): PendingAction[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingAction[]) : [];
  } catch {
    return [];
  }
}

function firstPendingTool(raw: string | null | undefined): string | null {
  const actions = safeParseActions(raw);
  for (const a of actions) for (const c of a.calls) if (c.name) return c.name;
  return null;
}

function safeDependencyCount(raw: string): number {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function roleLabel(role: string): string {
  if (role === "filer") return "Issue filer";
  return role.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function relativeTime(value: string, now: number): string {
  const elapsed = Math.max(0, now - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function pausedStateHintFor(column: string): string | null {
  if (column === "blocked") {
    return "The agent needs an answer, a sign-in, or a retry before it can continue.";
  }
  if (column === "approval") {
    return "The agent proposed an external or irreversible action. It will not run until you approve it.";
  }
  return null;
}

function groupTasksByDate(tasks: Task[], now: number): Array<{ label: string; tasks: Task[] }> {
  const current = new Date(now);
  const today = new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  const ranges = [
    { label: "Today", start: today, end: Number.POSITIVE_INFINITY },
    { label: "Yesterday", start: today - day, end: today },
    { label: "Past week", start: today - 7 * day, end: today - day },
    { label: "Past month", start: today - 30 * day, end: today - 7 * day },
    { label: "Earlier", start: Number.NEGATIVE_INFINITY, end: today - 30 * day },
  ];

  return ranges.map((range) => ({
    label: range.label,
    tasks: tasks
      .filter((task) => {
        const updatedAt = new Date(task.updatedAt).getTime();
        return Number.isFinite(updatedAt) && updatedAt >= range.start && updatedAt < range.end;
      })
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
  }));
}

interface PendingAction {
  type: string;
  calls: Array<{ id: string; name?: string; args?: string }>;
}

function prettyArgs(args?: string): string {
  try {
    return JSON.stringify(JSON.parse(args ?? "{}"), null, 2);
  } catch {
    return args ?? "";
  }
}

function prettyPayload(payload: string): string {
  try {
    const obj = JSON.parse(payload);
    if (typeof obj === "string") return obj.slice(0, 1500);
    return JSON.stringify(obj, null, 2).slice(0, 1500);
  } catch {
    return payload.slice(0, 1500);
  }
}

function eventLabel(type: string): string {
  if (type.includes("approval") || type === "pause.pending") return "Gate";
  if (type.startsWith("tool")) return "Tool";
  if (type.startsWith("thread")) return "Run";
  if (type === "sandbox.created") return "Box";
  if (type === "turn.done") return "Done";
  return "Event";
}
