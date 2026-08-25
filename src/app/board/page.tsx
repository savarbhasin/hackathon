"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Task {
  id: string;
  title: string;
  role: string;
  column: string;
  dependsOn: string;
  error: string | null;
  pendingActions?: string | null;
  updatedAt: string;
}

interface Mission {
  tasks: Task[];
}

const COLUMNS = [
  { key: "backlog", label: "Backlog", rail: "bg-state-backlog", text: "text-state-backlog" },
  { key: "working", label: "Working", rail: "bg-state-working", text: "text-state-working" },
  { key: "blocked", label: "Blocked", rail: "bg-state-blocked", text: "text-state-blocked" },
  { key: "approval", label: "Needs approval", rail: "bg-state-approval", text: "text-state-approval" },
  { key: "settled", label: "Settled", rail: "bg-state-settled", text: "text-state-settled" },
] as const;

export default function Board() {
  const [missions, setMissions] = useState<Mission[]>([]);
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
                    <StateTaskGroups tasks={tasks} now={now} />
                  </div>
                </section>
              );
          })}
        </div>
      </div>
    </main>
  );
}

function StateTaskGroups({
  tasks,
  now,
}: {
  tasks: Task[];
  now: number;
}) {
  const [today, ...olderGroups] = groupTasksByDate(tasks, now);

  if (tasks.length === 0) {
    return <p className="py-6 text-center font-mono text-[9px] uppercase tracking-[0.14em] text-ink-faint">Empty</p>;
  }

  return (
    <div className="space-y-2">
      {today.tasks.map((task) => (
        <Card key={task.id} task={task} now={now} />
      ))}

      {today.tasks.length === 0 && (
        <p className="py-3 text-center font-mono text-[8px] uppercase tracking-[0.14em] text-ink-faint">No tasks today</p>
      )}

      {olderGroups.filter((group) => group.tasks.length > 0).map((group) => (
        <TaskDateGroup key={group.label} group={group} now={now} />
      ))}
    </div>
  );
}

function Card({
  task,
  now,
}: {
  task: Task;
  now: number;
}) {
  const gated = task.column === "approval";
  const blocked = task.column === "blocked";
  const toolName = gated || blocked ? firstPendingTool(task.pendingActions) : null;
  const dependencyCount = safeDependencyCount(task.dependsOn);

  return (
    <Link
      href={`/board/tasks/${task.id}`}
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
      {blocked && (
        <p className="mt-3 font-mono text-[8px] font-medium uppercase tracking-[0.14em] text-state-blocked">
          Response required{toolName ? ` / ${toolName}` : ""}
        </p>
      )}
      {task.error && (
        <p className="mt-1 line-clamp-2 font-mono text-[10px] leading-relaxed text-state-blocked">
          {task.error}
        </p>
      )}
    </Link>
  );
}

function TaskDateGroup({
  group,
  now,
}: {
  group: { label: string; tasks: Task[] };
  now: number;
}) {
  const initiallyOpen = group.label === "Yesterday" || group.label === "Past week";
  const [open, setOpen] = useState(initiallyOpen);
  const cards = (
    <div className="space-y-2">
      {group.tasks.map((task) => (
        <Card key={task.id} task={task} now={now} />
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
  calls: Array<{ name?: string }>;
}
