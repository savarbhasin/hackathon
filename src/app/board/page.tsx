"use client";

import { useCallback, useEffect, useState } from "react";

interface Task {
  id: string;
  missionId: string;
  title: string;
  detail: string | null;
  role: string;
  column: string;
  sessionId: string | null;
  dependsOn: string;
  handoff: string | null;
  output: string | null;
  error: string | null;
  pendingActions?: string | null;
}

interface Mission {
  id: string;
  title: string;
  goal: string;
  status: string;
  tasks: Task[];
}

const COLUMNS = [
  { key: "backlog", label: "Backlog", accent: "text-neutral-400" },
  { key: "working", label: "Working", accent: "text-sky-400" },
  { key: "blocked", label: "Blocked", accent: "text-amber-400" },
  { key: "approval", label: "⚠ Licence Required", accent: "text-red-400" },
  { key: "settled", label: "Settled", accent: "text-emerald-400" },
] as const;

const ROLE_COLORS: Record<string, string> = {
  researcher: "border-cyan-800 bg-cyan-950/60 text-cyan-300",
  writer: "border-violet-800 bg-violet-950/60 text-violet-300",
  filer: "border-pink-800 bg-pink-950/60 text-pink-300",
};

export default function Board() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

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

  return (
    <main className="flex h-dvh flex-col bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-800 px-6 py-3">
        <div className="flex items-center gap-3">
          <a href="/" className="text-sm text-neutral-400 transition hover:text-white">
            ← Chat
          </a>
          <span className="text-lg font-semibold tracking-tight">Fleet Board</span>
        </div>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-widest ${
            connected
              ? "border-emerald-700 bg-emerald-950 text-emerald-400"
              : "border-red-800 bg-red-950 text-red-400"
          }`}
        >
          {connected ? "live" : "reconnecting"}
        </span>
      </header>

      <div className="grid flex-1 grid-cols-5 gap-3 overflow-hidden p-3">
        {COLUMNS.map((col) => {
          const tasks = missions.flatMap((m) =>
            m.tasks.filter((t) => t.column === col.key).map((t) => ({ task: t, mission: m }))
          );
          return (
            <section
              key={col.key}
              className="flex min-h-0 flex-col rounded-xl border border-neutral-800 bg-neutral-900/40"
            >
              <h2 className={`flex items-center justify-between px-3 py-2.5 text-xs font-semibold uppercase tracking-widest ${col.accent}`}>
                {col.label}
                <span className="rounded-full bg-neutral-800 px-1.5 text-[10px] text-neutral-400">
                  {tasks.length}
                </span>
              </h2>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {tasks.map(({ task, mission }) => (
                  <Card key={task.id} task={task} missionTitle={mission.title} onClick={() => setSelected(task.id)} />
                ))}
                {tasks.length === 0 && (
                  <p className="px-1 py-4 text-center text-[11px] text-neutral-700">empty</p>
                )}
              </div>
            </section>
          );
        })}
      </div>

      {selected && <Drawer taskId={selected} onClose={() => setSelected(null)} />}
    </main>
  );
}

function Card({ task, missionTitle, onClick }: { task: Task; missionTitle: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`block w-full rounded-lg border p-3 text-left transition hover:border-neutral-500 ${
        task.column === "approval"
          ? "border-red-900 bg-red-950/30"
          : "border-neutral-800 bg-neutral-900"
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${ROLE_COLORS[task.role] ?? "border-neutral-700 bg-neutral-800 text-neutral-300"}`}>
          {task.role}
        </span>
        {task.dependsOn !== "[]" && (
          <span className="font-mono text-[10px] text-neutral-600" title={task.dependsOn}>
            ⛓ deps
          </span>
        )}
      </div>
      <p className="text-xs font-medium leading-snug text-neutral-200">{task.title}</p>
      <p className="mt-1 truncate text-[10px] text-neutral-600">{missionTitle}</p>
      {(task.handoff || task.output) && task.column === "settled" && (
        <p className="mt-1.5 line-clamp-2 text-[10px] italic text-emerald-500/80">
          ↳ {task.handoff ?? task.output}
        </p>
      )}
      {task.error && <p className="mt-1 line-clamp-2 text-[10px] text-amber-600">{task.error}</p>}
    </button>
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

  const load = useCallback(async () => {
    const res = await fetch(`/api/tasks/${taskId}`);
    if (res.ok) setTask(await res.json());
  }, [taskId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2000);
    return () => clearInterval(t);
  }, [load]);

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await fetch(`/api/tasks/${taskId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await new Promise((r) => setTimeout(r, 500));
      await load();
    } finally {
      setBusy(false);
    }
  }

  const pendingCalls = safeParseActions(task?.pendingActions);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60" onClick={onClose}>
      <aside
        className="flex w-[480px] flex-col overflow-y-auto border-l border-neutral-800 bg-neutral-950 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        {!task ? (
          <p className="text-sm text-neutral-500">loading…</p>
        ) : (
          <>
            <div className="mb-3 flex items-start justify-between">
              <div>
                <span className={`mr-2 rounded border px-1.5 py-0.5 font-mono text-[10px] ${ROLE_COLORS[task.role]}`}>
                  {task.role}
                </span>
                <span className="font-mono text-[10px] text-neutral-600">{task.id}</span>
              </div>
              <button onClick={onClose} className="text-neutral-500 hover:text-white">
                ✕
              </button>
            </div>

            <h3 className="text-base font-semibold leading-snug">{task.title}</h3>
            {task.detail && (
              <p className="mt-2 whitespace-pre-wrap rounded-lg border border-neutral-800 bg-neutral-900 p-3 text-xs leading-relaxed text-neutral-400">
                {task.detail}
              </p>
            )}
            {task.error && (
              <p className="mt-2 rounded-lg border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-400">
                {task.error}
              </p>
            )}

            {pendingCalls.length > 0 && (
              <div className="mt-4 space-y-3">
                {pendingCalls.map((a) =>
                  a.calls.map((call) => (
                    <div key={call.id} className="rounded-lg border border-red-900 bg-red-950/30 p-3">
                      <p className="font-mono text-[10px] uppercase tracking-wider text-red-400">
                        {a.type === "tool.approval_required" ? "irreversible action" : "agent asks"}
                        {call.name ? ` · ${call.name}` : ""}
                      </p>
                      {call.args && (
                        <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all text-[10px] text-neutral-400">
                          {prettyArgs(call.args)}
                        </pre>
                      )}
                      {a.type === "tool.approval_required" ? (
                        <div className="mt-3 flex gap-2">
                          <button
                            disabled={busy}
                            onClick={() => act({ action: "approve", allow: true })}
                            className="flex-1 rounded-md bg-emerald-600 px-3 py-2 text-xs font-medium hover:bg-emerald-500 disabled:opacity-40"
                          >
                            Approve
                          </button>
                          <button
                            disabled={busy}
                            onClick={() => act({ action: "approve", allow: false, reason: "denied from board" })}
                            className="flex-1 rounded-md bg-neutral-800 px-3 py-2 text-xs font-medium text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
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
                            placeholder="Your answer…"
                            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-2 text-xs outline-none focus:border-neutral-500"
                          />
                          <button
                            disabled={busy || !answer.trim()}
                            className="rounded-md bg-sky-600 px-3 py-2 text-xs font-medium hover:bg-sky-500 disabled:opacity-40"
                          >
                            Reply
                          </button>
                        </form>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {task.column === "backlog" && (
              <button
                disabled={busy}
                onClick={() => act({ action: "dispatch" })}
                className="mt-4 rounded-lg bg-sky-600 px-3 py-2 text-xs font-medium hover:bg-sky-500 disabled:opacity-40"
              >
                ▶ Dispatch now
              </button>
            )}

            {(task.handoff || task.output) && task.column === "settled" && (
              <div className="mt-4 rounded-lg border border-emerald-900 bg-emerald-950/20 p-3">
                <p className="text-[10px] uppercase tracking-widest text-emerald-500">handoff to successors</p>
                <p className="mt-1.5 whitespace-pre-wrap text-xs leading-relaxed text-emerald-200/90">
                  {task.handoff ?? task.output}
                </p>
              </div>
            )}

            <h4 className="mt-6 mb-2 text-[10px] uppercase tracking-widest text-neutral-500">
              Event log
            </h4>
            <div className="space-y-1 pb-8">
              {[...task.events].reverse().map((e) => (
                <details key={e.id} className="group">
                  <summary className="cursor-pointer list-none rounded px-2 py-1 font-mono text-[10px] text-neutral-500 transition hover:bg-neutral-900 hover:text-neutral-300">
                    <span className="text-neutral-700">{new Date(e.createdAt).toLocaleTimeString()} </span>
                    {eventIcon(e.type)} {e.type}
                  </summary>
                  <pre className="mx-2 mb-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded bg-black/50 p-2 text-[10px] text-neutral-500">
                    {prettyPayload(e.payload)}
                  </pre>
                </details>
              ))}
              {task.events.length === 0 && <p className="px-2 text-xs text-neutral-700">no events</p>}
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

function eventIcon(type: string): string {
  if (type.includes("approval") || type === "pause.pending") return "⚠";
  if (type.startsWith("tool")) return "⚙";
  if (type.startsWith("thread")) return "⑃";
  if (type === "sandbox.created") return "▣";
  if (type === "turn.done") return "✓";
  return "·";
}
