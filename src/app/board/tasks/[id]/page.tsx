"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface TaskEvent {
  id: string;
  seq: number;
  type: string;
  payload: string;
  createdAt: string;
}

interface TaskDocument {
  id: string;
  title: string;
  updatedAt: string;
  authorRole: string;
  kind: string;
}

interface Predecessor {
  id: string;
  title: string;
  column: string;
  role: string;
}

interface TaskDetail {
  id: string;
  title: string;
  detail: string | null;
  role: string;
  agentPrompt: string | null;
  agentInstructions: string | null;
  column: string;
  dependsOn: string;
  handoff: string | null;
  output: string | null;
  error: string | null;
  pendingActions: string | null;
  createdAt: string;
  updatedAt: string;
  mission: { id: string; title: string; goal: string };
  predecessors: Predecessor[];
  documents: TaskDocument[];
  events: TaskEvent[];
}

interface PendingAction {
  type: string;
  calls: Array<{
    id: string;
    threadId?: string | null;
    name?: string;
    args?: string;
  }>;
}

interface ActivityItem {
  id: string;
  at: string;
  title: string;
  detail?: string;
  tone?: "working" | "blocked" | "approval" | "settled";
}

const STATUS: Record<string, { label: string; description: string; color: string; dot: string }> = {
  backlog: {
    label: "Backlog",
    description: "Ready to start",
    color: "text-state-backlog",
    dot: "bg-state-backlog",
  },
  working: {
    label: "Working",
    description: "Agent is running",
    color: "text-state-working",
    dot: "bg-state-working",
  },
  blocked: {
    label: "Blocked",
    description: "Waiting for an answer or connection",
    color: "text-state-blocked",
    dot: "bg-state-blocked",
  },
  approval: {
    label: "Needs approval",
    description: "An irreversible action is paused",
    color: "text-state-approval",
    dot: "bg-state-approval",
  },
  settled: {
    label: "Settled",
    description: "Work is complete",
    color: "text-state-settled",
    dot: "bg-state-settled",
  },
};

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  const fetchTask = useCallback(async (): Promise<TaskDetail> => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, { cache: "no-store" });
    if (!response.ok) {
      if (response.status === 404) throw new Error("This task does not exist.");
      throw new Error("Could not load this task.");
    }
    return response.json() as Promise<TaskDetail>;
  }, [id]);

  const loadTask = useCallback(async () => {
    setTask(await fetchTask());
  }, [fetchTask]);

  useEffect(() => {
    let alive = true;
    void fetchTask()
      .then((next) => {
        if (alive) setTask(next);
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [fetchTask]);

  async function act(body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
      };
      if (!response.ok) throw new Error(result.error ?? result.reason ?? "The task could not be updated.");
      await loadTask();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <TaskLoading />;

  if (!task) {
    return (
      <main className="flex h-full min-w-0 flex-col bg-deck">
        <TaskHeader />
        <div className="mx-auto flex w-full max-w-xl flex-1 flex-col items-start justify-center px-6 pb-24">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-state-blocked">Task unavailable</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-ink">{error ?? "Could not load this task."}</h1>
          <div className="mt-6 flex gap-3">
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-ink px-4 py-2.5 text-xs font-semibold text-deck hover:bg-white"
            >
              Try again
            </button>
            <Link href="/board" className="rounded-md border border-line-strong px-4 py-2.5 text-xs font-semibold text-ink-soft hover:text-ink">
              Back to fleet
            </Link>
          </div>
        </div>
      </main>
    );
  }

  const pendingActions = parsePendingActions(task.pendingActions);
  const semanticEvents = task.events.filter((event) => event.type.startsWith("activity."));
  const activitySource = semanticEvents.length > 0 ? semanticEvents : task.events;
  const activity = activitySource.flatMap((event) => {
    const item = semanticEvents.length > 0
      ? semanticActivityFromEvent(event)
      : legacyActivityFromEvent(event);
    return item ? [item] : [];
  });
  const status = STATUS[task.column] ?? STATUS.backlog;

  return (
    <main className="h-full min-w-0 overflow-y-auto bg-deck">
      <TaskHeader />

      <div className="mx-auto w-full max-w-[1180px] px-5 py-7 sm:px-8 sm:py-10 lg:px-10">
        <section className="border-b border-line pb-8">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className={`inline-flex items-center gap-2 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] ${status.color}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot} ${task.column === "working" ? "led-live" : ""}`} />
              {status.label}
            </span>
            <span className="h-3 w-px bg-line-strong" />
            <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-role-researcher">
              {roleLabel(task.role)}
            </span>
            <span className="text-[11px] text-ink-faint">{status.description}</span>
          </div>

          <h1 className="mt-5 max-w-4xl text-3xl font-semibold leading-[1.12] tracking-[-0.045em] text-ink sm:text-4xl">
            {task.title}
          </h1>
          <p className="mt-3 text-xs text-ink-faint">
            Part of <span className="text-ink-soft">{task.mission.title}</span>
          </p>

          <div className="mt-6 flex flex-wrap gap-x-7 gap-y-3 border-t border-line/70 pt-4">
            <TimeFact label="Created" value={formatDateTime(task.createdAt)} />
            <TimeFact label="Last update" value={formatDateTime(task.updatedAt)} />
            <TimeFact
              label={task.column === "settled" ? "Elapsed" : "Open for"}
              value={durationBetween(task.createdAt, task.updatedAt, task.column !== "settled")}
            />
          </div>
        </section>

        {error && (
          <div className="mt-5 rounded-lg border border-state-blocked/35 bg-state-blocked/[0.06] px-4 py-3 text-sm text-state-blocked" role="alert">
            {error}
          </div>
        )}

        <ActionPanel
          task={task}
          pendingActions={pendingActions}
          answer={answer}
          busy={busy}
          onAnswerChange={setAnswer}
          onAct={act}
        />

        <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.72fr)] lg:items-start">
          <div className="min-w-0 space-y-8">
            <ResultSection output={task.output} column={task.column} />

            {task.handoff && (
              <details className="group rounded-lg border border-line bg-panel/45">
                <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 [&::-webkit-details-marker]:hidden">
                  <Chevron />
                  <span className="text-sm font-semibold text-ink">Passed to successors</span>
                  <span className="ml-auto font-mono text-[8px] uppercase tracking-[0.14em] text-ink-faint">Handoff</span>
                </summary>
                <div className="border-t border-line px-5 py-5">
                  <div className="markdown text-sm text-ink-soft">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{task.handoff}</ReactMarkdown>
                  </div>
                </div>
              </details>
            )}

            <DocumentsSection documents={task.documents} />
            <ActivitySection items={activity} />
            <TechnicalEvents events={task.events} />
          </div>

          <aside className="min-w-0 space-y-5 lg:sticky lg:top-6">
            <InfoCard title="Assignment">
              {task.detail ? (
                <p className="whitespace-pre-wrap text-sm leading-7 text-ink-soft">{task.detail}</p>
              ) : (
                <p className="text-sm text-ink-faint">No additional instructions were recorded.</p>
              )}
            </InfoCard>

            <InfoCard title="Mission goal">
              <p className="whitespace-pre-wrap text-sm leading-7 text-ink-soft">{task.mission.goal}</p>
            </InfoCard>

            <Dependencies items={task.predecessors} />

            <details className="group rounded-lg border border-line bg-panel/55">
              <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3.5 [&::-webkit-details-marker]:hidden">
                <Chevron />
                <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-soft">Agent instructions</span>
              </summary>
              <div className="border-t border-line px-4 py-4">
                <p className="whitespace-pre-wrap text-xs leading-6 text-ink-soft">
                  {task.agentInstructions ?? task.agentPrompt ?? "No agent instructions are available."}
                </p>
              </div>
            </details>
          </aside>
        </div>
      </div>
    </main>
  );
}

function TaskHeader() {
  return (
    <header className="sticky top-0 z-20 flex h-16 items-center border-b border-line bg-deck/95 px-5 backdrop-blur-sm sm:px-6">
      <Link
        href="/board"
        className="inline-flex items-center gap-2 rounded-md px-2 py-2 font-mono text-[9px] font-semibold uppercase tracking-[0.15em] text-ink-faint transition-colors hover:bg-panel-hi hover:text-ink"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
          <path d="m10 3-5 5 5 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Fleet
      </Link>
      <span className="mx-3 h-4 w-px bg-line" />
      <span className="text-sm font-semibold text-ink">Task record</span>
    </header>
  );
}

function TaskLoading() {
  return (
    <main className="h-full min-w-0 overflow-hidden bg-deck">
      <TaskHeader />
      <div className="mx-auto max-w-[1180px] animate-pulse px-5 py-10 sm:px-8 lg:px-10">
        <div className="h-3 w-40 rounded bg-panel-hi" />
        <div className="mt-6 h-10 max-w-3xl rounded bg-panel-hi" />
        <div className="mt-3 h-4 w-56 rounded bg-panel-hi" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.72fr)]">
          <div className="h-72 rounded-lg border border-line bg-panel/60" />
          <div className="h-60 rounded-lg border border-line bg-panel/60" />
        </div>
      </div>
    </main>
  );
}

function TimeFact({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-2 text-[11px]">
      <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.14em] text-ink-faint">{label}</span>
      <span className="text-ink-soft">{value}</span>
    </span>
  );
}

function ActionPanel({
  task,
  pendingActions,
  answer,
  busy,
  onAnswerChange,
  onAct,
}: {
  task: TaskDetail;
  pendingActions: PendingAction[];
  answer: string;
  busy: boolean;
  onAnswerChange: (value: string) => void;
  onAct: (body: Record<string, unknown>) => Promise<void>;
}) {
  const approvals = pendingActions.filter((action) => action.type === "tool.approval_required");
  const questions = pendingActions.filter((action) => action.type === "tool.response_required");
  const needsAuth = pendingActions.some((action) => action.type === "mcp.auth_required");

  if (approvals.length > 0) {
    return (
      <section className="relative mt-6 overflow-hidden rounded-lg border border-state-approval/50 bg-state-approval/[0.07] p-5 sm:p-6">
        <span className="absolute inset-y-0 left-0 w-1 bg-state-approval" />
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-approval">Decision required</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em] text-ink">Review the proposed action</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-soft">The agent is paused. Nothing below runs until you approve it.</p>
        <PendingCalls actions={approvals} />
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={busy}
            onClick={() => void onAct({ action: "approve", allow: true })}
            className="rounded-md bg-ink px-5 py-3 text-xs font-semibold text-deck transition-colors hover:bg-white disabled:opacity-40"
          >
            {busy ? "Applying decision..." : "Approve action"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void onAct({ action: "approve", allow: false, reason: "Denied from task page" })}
            className="rounded-md border border-state-approval/50 px-5 py-3 text-xs font-semibold text-state-approval transition-colors hover:bg-state-approval/10 disabled:opacity-40"
          >
            Deny
          </button>
        </div>
      </section>
    );
  }

  if (questions.length > 0) {
    return (
      <section className="question-attention relative mt-6 overflow-hidden rounded-lg p-5 sm:p-6">
        <div className="flex items-start gap-3 border-b border-line pb-4">
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-state-blocked" />
          <div>
            <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-blocked">Agent needs your input</p>
            <h2 className="mt-1.5 text-lg font-semibold tracking-[-0.025em] text-ink">Answer to resume the task</h2>
            <p className="mt-1.5 text-xs leading-5 text-ink-faint">The agent will continue as soon as you send a response.</p>
          </div>
        </div>
        <PendingCalls actions={questions} tone="question" />
        <form
          className="mt-5 border-t border-line pt-5"
          onSubmit={(event) => {
            event.preventDefault();
            const content = answer.trim();
            if (!content) return;
            void onAct({ action: "answer", content }).then(() => onAnswerChange(""));
          }}
        >
          <label htmlFor="task-answer" className="font-mono text-[9px] font-semibold uppercase tracking-[0.14em] text-ink-soft">Your answer</label>
          <textarea
            id="task-answer"
            value={answer}
            onChange={(event) => onAnswerChange(event.target.value)}
            rows={3}
            placeholder="Give the missing detail plainly."
            className="mt-2 w-full resize-y rounded-md border border-line-strong bg-deck/70 px-3 py-3 text-sm leading-6 text-ink outline-none placeholder:text-ink-faint focus:border-signal focus:ring-1 focus:ring-signal/30"
          />
          <button
            disabled={busy || !answer.trim()}
            className="mt-3 rounded-md bg-signal px-5 py-3 text-xs font-semibold text-deck transition-colors hover:brightness-110 disabled:opacity-40"
          >
            {busy ? "Sending..." : "Send answer"}
          </button>
        </form>
      </section>
    );
  }

  if (needsAuth) {
    return (
      <section className="relative mt-6 overflow-hidden rounded-lg border border-state-blocked/50 bg-state-blocked/[0.07] p-5 sm:p-6">
        <span className="absolute inset-y-0 left-0 w-1 bg-state-blocked" />
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-blocked">Connector sign-in required</p>
        <p className="mt-2 text-sm leading-6 text-ink-soft">Open TrueForge and authorize the connector this agent was using, then return here.</p>
      </section>
    );
  }

  if (task.column === "blocked") {
    return (
      <section className="relative mt-6 overflow-hidden rounded-lg border border-state-blocked/40 bg-state-blocked/[0.05] p-5">
        <span className="absolute inset-y-0 left-0 w-1 bg-state-blocked" />
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-blocked">Agent stopped</p>
        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-soft">{task.error ?? "The agent could not continue. Check the activity below for the last recorded event."}</p>
      </section>
    );
  }

  if (task.column === "backlog") {
    return (
      <section className="mt-6 flex flex-wrap items-center gap-4 rounded-lg border border-line bg-panel/55 p-5">
        <div>
          <p className="text-sm font-semibold text-ink">This task has not started.</p>
          <p className="mt-1 text-xs text-ink-faint">Starting it manually can bypass dependency ordering.</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onAct({ action: "dispatch" })}
          className="ml-auto rounded-md bg-signal px-4 py-2.5 text-xs font-semibold text-deck hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Starting..." : "Dispatch now"}
        </button>
      </section>
    );
  }

  return null;
}

function PendingCalls({ actions, tone = "default" }: { actions: PendingAction[]; tone?: "default" | "question" }) {
  return (
    <div className="mt-4 space-y-2">
      {actions.flatMap((action) => action.calls).map((call) => {
        const question = questionFromArgs(call.args);
        return (
          <div key={call.id} className={`rounded-md border p-3.5 ${tone === "question" ? "border-line bg-deck/55" : "border-line-strong bg-deck/80"}`}>
            <p className={`font-mono text-[9px] font-semibold uppercase tracking-[0.12em] ${tone === "question" ? "text-ink-faint" : "text-ink-soft"}`}>{call.name ? toolLabel(call.name) : "Agent request"}</p>
            {question && <p className="mt-2 text-sm leading-6 text-ink">{question}</p>}
            {call.args && !question && (
              <pre className="mt-2 max-h-52 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-5 text-ink-soft">{prettyJson(call.args)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ResultSection({ output, column }: { output: string | null; column: string }) {
  return (
    <section>
      <SectionHeading eyebrow="Agent report" title="Result" />
      <div className="mt-4 rounded-lg border border-line bg-panel/55 p-5 sm:p-6">
        {output ? (
          <div className="markdown text-sm text-ink-soft">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
          </div>
        ) : (
          <p className="text-sm leading-6 text-ink-faint">
            {column === "settled" ? "The task finished without a written result." : "The agent has not reported a result yet."}
          </p>
        )}
      </div>
    </section>
  );
}

function DocumentsSection({ documents }: { documents: TaskDocument[] }) {
  return (
    <section>
      <SectionHeading eyebrow={`${documents.length} linked`} title="Documents" />
      {documents.length > 0 ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {documents.map((document) => (
            <Link
              key={document.id}
              href={`/docs?document=${encodeURIComponent(document.id)}`}
              className="group rounded-lg border border-line bg-panel/55 p-4 transition-colors hover:border-line-strong hover:bg-panel-hi"
            >
              <span className="flex items-start gap-3">
                <svg viewBox="0 0 20 20" className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden="true">
                  <path d="M5 3.5h7l3 3V16.5H5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                  <path d="M12 3.5v3h3M7.5 10h5M7.5 12.5h4" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="block line-clamp-2 text-sm font-semibold leading-5 text-ink group-hover:text-white">{document.title}</span>
                    {document.kind === "handoff" && (
                      <span className="rounded border border-role-researcher/30 bg-role-researcher/[0.08] px-1.5 py-0.5 font-mono text-[7px] font-semibold uppercase tracking-[0.14em] text-role-researcher">
                        Handoff
                      </span>
                    )}
                  </span>
                  {document.kind === "handoff" && (
                    <span className="mt-1.5 block text-[11px] leading-4 text-ink-soft">
                      Context passed to dependent tasks
                    </span>
                  )}
                  <span className="mt-2 block font-mono text-[8px] uppercase tracking-[0.12em] text-ink-faint">{roleLabel(document.authorRole)} / {formatShortDate(document.updatedAt)}</span>
                </span>
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <p className="mt-4 rounded-lg border border-dashed border-line px-4 py-5 text-sm text-ink-faint">This task did not create a document.</p>
      )}
    </section>
  );
}

function ActivitySection({ items }: { items: ActivityItem[] }) {
  return (
    <section>
      <SectionHeading eyebrow={`${items.length} meaningful events`} title="Activity" />
      <div className="mt-4 rounded-lg border border-line bg-panel/40">
        <div className="h-80 overflow-y-auto overscroll-contain px-4 sm:px-5">
          {items.length > 0 ? (
            <ol>
              {items.map((item, index) => (
                <li key={item.id} className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-3 border-b border-line/70 py-4 last:border-b-0">
                  {index < items.length - 1 && <span className="absolute left-[6px] top-6 h-[calc(100%-12px)] w-px bg-line-strong" />}
                  <span className={`relative z-10 mt-1 h-3 w-3 rounded-full border-2 border-panel ${activityDot(item.tone)}`} />
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="text-sm font-semibold text-ink">{item.title}</p>
                      <time className="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">{formatEventTime(item.at)}</time>
                    </div>
                    {item.detail && <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-ink-soft">{item.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="py-5 text-sm text-ink-faint">No human-readable activity has been recorded yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function TechnicalEvents({ events }: { events: TaskEvent[] }) {
  return (
    <details className="group border-t border-line">
      <summary className="flex cursor-pointer list-none items-center gap-3 py-4 [&::-webkit-details-marker]:hidden">
        <Chevron />
        <span className="font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-faint">Raw technical events</span>
        <span className="ml-auto font-mono text-[9px] tabular-nums text-ink-faint">{events.length}</span>
      </summary>
      <div className="space-y-2 pb-4">
        {events.map((event) => (
          <details key={event.id} className="rounded-md border border-line bg-panel/40">
            <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2.5 font-mono text-[9px] text-ink-soft [&::-webkit-details-marker]:hidden">
              <span className="text-ink-faint">{formatEventTime(event.createdAt)}</span>
              <span className="truncate">{event.type}</span>
              <span className="ml-auto text-ink-faint">#{event.seq}</span>
            </summary>
            <pre className="max-h-80 overflow-auto border-t border-line bg-deck p-3 font-mono text-[10px] leading-5 text-ink-soft">{prettyJson(event.payload)}</pre>
          </details>
        ))}
      </div>
    </details>
  );
}

function Dependencies({ items }: { items: Predecessor[] }) {
  return (
    <InfoCard title="Dependencies" suffix={String(items.length)}>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.id}>
              <Link href={`/board/tasks/${encodeURIComponent(item.id)}`} className="block rounded-md border border-line bg-deck/40 px-3 py-3 transition-colors hover:border-line-strong hover:bg-panel-hi">
                <span className="flex items-center gap-2">
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS[item.column]?.dot ?? "bg-state-backlog"}`} />
                  <span className="font-mono text-[8px] font-semibold uppercase tracking-[0.12em] text-ink-faint">{roleLabel(item.role)}</span>
                </span>
                <span className="mt-1.5 block text-xs font-semibold leading-5 text-ink">{item.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-ink-faint">This task can start without another task finishing first.</p>
      )}
    </InfoCard>
  );
}

function InfoCard({ title, suffix, children }: { title: string; suffix?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel/55 p-4">
      <h2 className="mb-3 flex items-center font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-faint">
        {title}
        {suffix && <span className="ml-auto tabular-nums">{suffix}</span>}
      </h2>
      {children}
    </section>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return (
    <div>
      <p className="font-mono text-[8px] font-semibold uppercase tracking-[0.18em] text-ink-faint">{eyebrow}</p>
      <h2 className="mt-1 text-xl font-semibold tracking-[-0.025em] text-ink">{title}</h2>
    </div>
  );
}

function Chevron() {
  return (
    <svg viewBox="0 0 12 12" className="h-3 w-3 shrink-0 text-ink-faint transition-transform group-open:rotate-90" aria-hidden="true">
      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function parsePendingActions(raw: string | null): PendingAction[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as PendingAction[]) : [];
  } catch {
    return [];
  }
}

function semanticActivityFromEvent(event: TaskEvent): ActivityItem | null {
  const payload = parsePayload(event.payload);
  const defaults: Record<string, { title: string; tone: ActivityItem["tone"] }> = {
    "activity.started": { title: "Agent started work", tone: "working" },
    "activity.completed": { title: "Task completed", tone: "settled" },
    "activity.failed": { title: "Agent run failed", tone: "blocked" },
    "activity.cancelled": { title: "Agent run cancelled", tone: "blocked" },
    "activity.waiting_approval": { title: "Waiting for approval", tone: "approval" },
    "activity.waiting_response": { title: "Waiting for a response", tone: "blocked" },
    "activity.approval_resolved": {
      title: "Approval decision recorded",
      tone: payload?.allowed === false ? "blocked" : "working",
    },
    "activity.response_sent": { title: "Response sent to agent", tone: "working" },
    "activity.document_created": { title: "Document created", tone: "working" },
    "activity.document_updated": { title: "Document updated", tone: "working" },
  };
  const fallback = defaults[event.type];
  if (!fallback) return null;

  const title = typeof payload?.title === "string" && payload.title.trim()
    ? payload.title.trim()
    : fallback.title;
  const details = [payload?.summary, payload?.message, payload?.reason]
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => concise(value));
  if (Array.isArray(payload?.tools)) {
    const tools = payload.tools.filter((value): value is string => typeof value === "string");
    if (tools.length > 0) details.push(`Tools: ${tools.join(", ")}`);
  }

  return {
    id: event.id,
    at: event.createdAt,
    title,
    detail: details.length > 0 ? details.join("\n") : undefined,
    tone: fallback.tone,
  };
}

function legacyActivityFromEvent(event: TaskEvent): ActivityItem | null {
  const payload = parsePayload(event.payload);
  switch (event.type) {
    case "turn.created":
      return { id: event.id, at: event.createdAt, title: "Agent started working", tone: "working" };
    case "mcp.initialize": {
      const servers = Array.isArray(payload?.mcpServers)
        ? payload.mcpServers.flatMap((server) => {
            if (!server || typeof server !== "object") return [];
            const name = (server as Record<string, unknown>).name;
            return typeof name === "string" ? [name] : [];
          })
        : [];
      return {
        id: event.id,
        at: event.createdAt,
        title: "Connected tools",
        detail: servers.length > 0 ? servers.join(", ") : undefined,
        tone: "working",
      };
    }
    case "tool.approval_required":
      return { id: event.id, at: event.createdAt, title: "Paused for approval", tone: "approval" };
    case "tool.response_required":
      return { id: event.id, at: event.createdAt, title: "Asked for more information", tone: "blocked" };
    case "pause.pending":
      return { id: event.id, at: event.createdAt, title: "Waiting for you", tone: "blocked" };
    case "specialist.mark_done":
      return {
        id: event.id,
        at: event.createdAt,
        title: "Agent reported completion",
        detail: typeof payload?.summary === "string" ? payload.summary : undefined,
        tone: "settled",
      };
    case "tool.response": {
      const content = typeof payload?.content === "string" ? payload.content.trim() : "";
      if (!content || content.length > 240 || content.startsWith("{") || content.includes("inputSchema")) return null;
      if (!/(document (created|updated)|recorded|created issue|issue created|saved)/i.test(content)) return null;
      return { id: event.id, at: event.createdAt, title: "Tool completed", detail: content, tone: "working" };
    }
    case "turn.done": {
      const state = payload?.state;
      const status = state && typeof state === "object" ? (state as Record<string, unknown>).status : undefined;
      if (status === "done") return { id: event.id, at: event.createdAt, title: "Agent finished", tone: "settled" };
      if (status === "error") return { id: event.id, at: event.createdAt, title: "Agent stopped with an error", tone: "blocked" };
      if (status === "cancelled") return { id: event.id, at: event.createdAt, title: "Run was cancelled", tone: "blocked" };
      return null;
    }
    default:
      return null;
  }
}

function concise(value: string, max = 480): string {
  const clean = value.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function questionFromArgs(raw?: string): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.question === "string" ? parsed.question : null;
  } catch {
    return null;
  }
}

function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function roleLabel(role: string): string {
  if (role === "filer") return "Issue filer";
  return role.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function toolLabel(name: string): string {
  const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return bare.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityDot(tone: ActivityItem["tone"]): string {
  if (tone === "approval") return "bg-state-approval";
  if (tone === "blocked") return "bg-state-blocked";
  if (tone === "settled") return "bg-state-settled";
  return "bg-state-working";
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatShortDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value));
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function durationBetween(createdAt: string, updatedAt: string, stillOpen: boolean): string {
  const start = new Date(createdAt).getTime();
  const end = stillOpen ? Date.now() : new Date(updatedAt).getTime();
  const minutes = Math.max(0, Math.floor((end - start) / 60_000));
  if (minutes < 1) return "Less than a minute";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
