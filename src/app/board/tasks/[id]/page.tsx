"use client";

import Link from "next/link";
import { useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { use, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatMarkdown } from "@/components/chat-markdown";
import { groupConsecutiveSpecialistTools } from "@/lib/specialist-activity-display";

const convexApi = anyApi as any;

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
  sessionId: string | null;
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
  runId?: string | null;
  runStatus?: string | null;
  run?: { id: string; status: string | null } | null;
}

interface PendingAction {
  type: string;
  selector?: string;
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
  kind?: "status" | "narration" | "tool";
  toolCallId?: string;
  toolName?: string;
  toolPhase?: "started" | "completed";
}

interface LiveTool {
  name: string;
  at: string;
  toolCallId?: string;
  phase?: "started" | "completed";
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

function composeTaskDetail(coreValue: unknown, activityValue: unknown, documentValue: unknown, runStateValue: unknown): TaskDetail | null | undefined {
  if (coreValue === undefined || activityValue === undefined || documentValue === undefined || runStateValue === undefined) return undefined;
  if (!coreValue || typeof coreValue !== "object") return null;

  const core = asRecord(coreValue);
  if (!core) return null;
  const runState = asRecord(runStateValue);
  const activeRun = asRecord(runState?.active);
  const latestRun = asRecord(runState?.latest);
  const run = activeRun ?? latestRun;
  const runStatus = stringValue(run?.status);
  const rawPending = run?.pendingActions ?? core.pendingActions;
  const pendingActions = normalizePendingActions(rawPending, stringValue(run?.pendingActionSelector));
  const mission = asRecord(core.mission);
  const predecessors = Array.isArray(core.predecessors) ? core.predecessors.flatMap((value) => {
    const predecessor = asRecord(value);
    if (!predecessor) return [];
    return [{
      id: idValue(predecessor._id ?? predecessor.id),
      title: stringValue(predecessor.title) ?? "Untitled task",
      column: stringValue(predecessor.column) ?? "backlog",
      role: stringValue(predecessor.role) ?? "",
    }];
  }) : [];
  const events = Array.isArray(activityValue) ? activityValue.flatMap(normalizeEvent) : [];
  const documents = Array.isArray(documentValue) ? documentValue.flatMap(normalizeDocument) : [];
  const coreColumn = stringValue(core.column) ?? "backlog";

  return {
    id: idValue(core._id ?? core.id),
    title: stringValue(core.title ?? core.name) ?? "Untitled task",
    detail: textValue(core.detail),
    role: stringValue(core.role) ?? "",
    agentPrompt: textValue(core.agentPrompt),
    agentInstructions: textValue(core.agentInstructions ?? core.agentPrompt),
    column: columnFor(coreColumn, runStatus),
    sessionId: stringValue(core.sessionId) ?? stringValue(run?.sessionId),
    dependsOn: JSON.stringify(Array.isArray(core.dependsOn) ? core.dependsOn.map(idValue) : []),
    handoff: textValue(core.handoff),
    output: textValue(core.output) ?? textValue(run?.output),
    error: textValue(core.error) ?? textValue(run?.errorMessage),
    pendingActions: pendingActions.length > 0 ? JSON.stringify(pendingActions) : null,
    createdAt: dateText(core.createdAt),
    updatedAt: dateText(core.updatedAt),
    mission: {
      id: idValue(mission?._id ?? mission?.id),
      title: stringValue(mission?.title) ?? "Unknown mission",
      goal: stringValue(mission?.goal) ?? "",
    },
    predecessors,
    documents,
    events,
    runId: idValue(run?._id ?? run?.id) || null,
    runStatus,
    run: run ? { id: idValue(run._id ?? run.id), status: runStatus } : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function idValue(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function textValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  const record = asRecord(value);
  if (record && typeof record.content === "string") return record.content;
  if (record && typeof record.text === "string") return record.text;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function dateText(value: unknown): string {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function columnFor(taskColumn: string, runStatus: string | null): string {
  switch (runStatus) {
    case "queued":
    case "enqueued":
    case "connecting":
    case "running": return "working";
    case "waiting_for_approval": return "approval";
    case "waiting_for_user":
    case "failed": return "blocked";
    case "cancelled": return "backlog";
    case "completed": return "settled";
    default: return taskColumn;
  }
}

function normalizeEvent(value: unknown): TaskEvent[] {
  const event = asRecord(value);
  if (!event) return [];
  return [{
    id: idValue(event._id ?? event.id),
    seq: typeof event.seq === "number" ? event.seq : 0,
    type: stringValue(event.type) ?? "unknown",
    payload: payloadText(event.payload),
    createdAt: dateText(event.createdAt),
  }];
}

function normalizeDocument(value: unknown): TaskDocument[] {
  const document = asRecord(value);
  if (!document) return [];
  return [{
    id: idValue(document._id ?? document.id),
    title: stringValue(document.title) ?? "Untitled document",
    updatedAt: dateText(document.updatedAt),
    authorRole: stringValue(document.authorRole) ?? "unknown",
    kind: stringValue(document.kind) ?? "artifact",
  }];
}

function payloadText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
}

function normalizePendingActions(value: unknown, selector?: string | null): PendingAction[] {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return []; }
  }
  if (!Array.isArray(source)) return [];
  return source.flatMap((rawAction) => {
    const action = asRecord(rawAction);
    if (!action || typeof action.type !== "string") return [];
    const actionSelector = stringValue(action.selector) ?? selector ?? undefined;
    const rawCalls = Array.isArray(action.calls) ? action.calls : Array.isArray(action.toolCalls) ? action.toolCalls : [];
    const calls = rawCalls.flatMap((rawCall) => {
      const call = asRecord(rawCall);
      if (!call || typeof call.id !== "string") return [];
      const args = typeof call.args === "string"
        ? call.args
        : typeof action.question === "string"
          ? JSON.stringify({ question: action.question })
          : typeof action.argsPreview === "string" ? action.argsPreview : undefined;
      return [{
        id: call.id,
        threadId: typeof call.threadId === "string" || call.threadId === null ? call.threadId : typeof action.threadId === "string" || action.threadId === null ? action.threadId : undefined,
        ...(typeof call.name === "string" ? { name: call.name } : typeof action.name === "string" ? { name: action.name } : {}),
        ...(args ? { args } : {}),
      }];
    });
    return [{ type: action.type, ...(actionSelector ? { selector: actionSelector } : {}), calls }];
  });
}

export default function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const core = useQuery(convexApi.missions.taskCore, { taskId: id });
  const activityRows = useQuery(convexApi.missions.taskActivity, { taskId: id, limit: 2000 });
  const documentRows = useQuery(convexApi.missions.taskDocuments, { taskId: id, limit: 500 });
  const runState = useQuery(convexApi.agentRuns.taskRunState, { taskId: id });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  const task = useMemo(() => composeTaskDetail(core, activityRows, documentRows, runState), [core, activityRows, documentRows, runState]);
  const loading = core === undefined || activityRows === undefined || documentRows === undefined || runState === undefined;

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
          <h1 className="mt-3 text-2xl font-semibold tracking-[-0.03em] text-ink">{core === null ? "This task does not exist." : error ?? "Could not load this task."}</h1>
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
  const activity = activityItemsFromEvents(task.events);
  const liveTool = task.column === "working" ? latestSpecialistTool(task.events, task.runId) : null;
  const status = STATUS[task.column] ?? STATUS.backlog;

  return (
    <main className="h-full min-w-0 overflow-y-auto bg-deck">
      <TaskHeader />

      <div className="mx-auto w-full max-w-[1180px] px-5 py-7 sm:px-8 sm:py-10 lg:px-10">
        <section className="border-b border-line pb-4">
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
            <ActivitySection items={activity} liveTool={liveTool} />
            <TaskChat taskId={id} events={task.events} column={task.column} hasSession={Boolean(task.sessionId)} />
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
      <div className="mx-auto max-w-[1180px] px-5 py-10 sm:px-8 lg:px-10" role="status" aria-label="Loading task" aria-busy="true">
        <span className="sr-only">Loading task…</span>
        <div className="h-3 w-40 rounded shimmer" />
        <div className="mt-6 h-10 max-w-3xl rounded shimmer" />
        <div className="mt-3 h-4 w-56 rounded shimmer" />
        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.72fr)]">
          <div className="h-72 rounded-lg border border-line shimmer" />
          <div className="h-60 rounded-lg border border-line shimmer" />
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
  const approvalSelector = pauseSelector(approvals);
  const questionSelector = pauseSelector(questions);
  const needsAuth = pendingActions.some((action) => action.type === "mcp.auth_required");

  if (approvals.length > 0) {
    return (
      <section className="mt-6 rounded-lg border border-state-approval/50 bg-state-approval/[0.07] p-5 sm:p-6">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-approval">Decision required</p>
        <h2 className="mt-2 text-xl font-semibold tracking-[-0.025em] text-ink">Review the proposed action</h2>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-ink-soft">The agent is paused. Nothing below runs until you approve it.</p>
        <PendingCalls actions={approvals} />
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={busy || !approvalSelector}
            onClick={() => void onAct({ action: "approve", allow: true, selector: approvalSelector })}
            className="rounded-md bg-ink px-5 py-3 text-xs font-semibold text-deck transition-colors hover:bg-white disabled:opacity-40"
          >
            {busy ? "Applying decision..." : "Approve action"}
          </button>
          <button
            type="button"
            disabled={busy || !approvalSelector}
            onClick={() => void onAct({ action: "deny", allow: false, reason: "Denied from task page", selector: approvalSelector })}
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
            if (!content || !questionSelector) return;
            void onAct({ action: "answer", content, selector: questionSelector }).then(() => onAnswerChange(""));
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
            disabled={busy || !answer.trim() || !questionSelector}
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
      <section className="mt-6 rounded-lg border border-state-blocked/50 bg-state-blocked/[0.07] p-5 sm:p-6">
        <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-blocked">Connector sign-in required</p>
        <p className="mt-2 text-sm leading-6 text-ink-soft">Open TrueForge and authorize the connector this agent was using, then return here.</p>
      </section>
    );
  }

  if (task.column === "blocked") {
    return (
      <section className="mt-6 flex flex-wrap items-end gap-4 rounded-lg border border-state-blocked/40 bg-state-blocked/[0.05] p-5">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-state-blocked">Agent stopped</p>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-ink-soft">{task.error ?? "The agent could not continue. Check the activity below for the last recorded event."}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onAct({ action: "retry" })}
          className="h-fit shrink-0 self-end whitespace-nowrap rounded-md bg-signal px-4 py-2.5 text-xs font-semibold leading-5 text-deck transition-colors hover:brightness-110 disabled:opacity-40"
        >
          {busy ? "Retrying..." : "Retry task"}
        </button>
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

function pauseSelector(actions: PendingAction[]): string | undefined {
  for (const action of actions) {
    if (action.selector) return action.selector;
    const call = action.calls[0];
    if (call?.id) return call.id;
  }
  return undefined;
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

interface TaskChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  status?: string;
  clientMessageId?: string;
}

function isTaskMessageError(status?: string): boolean {
  if (!status) return false;
  const normalized = status.trim().toLowerCase();
  return normalized === "error" || normalized === "failed" || normalized.includes("failed");
}

function TaskChatAssistantMessage({ message, busy }: { message: TaskChatMessage; busy: boolean }) {
  const failed = isTaskMessageError(message.status);
  return (
    <div className="relative max-w-3xl pl-6 before:absolute before:bottom-0 before:left-[3px] before:top-0 before:w-px before:bg-line">
      <span className={`absolute left-0 top-1.5 h-[7px] w-[7px] rounded-full ${failed ? "bg-error" : (busy || message.status === "queued") && !message.content ? "bg-signal led-live" : "border border-line bg-deck"}`} />
      <p className={`mb-2 flex items-center gap-2 font-mono text-[8px] uppercase tracking-[0.2em] ${failed ? "text-error" : "text-state-working"}`}>
        {failed ? "Error" : "Task agent"}
        {!failed && (busy || message.status === "queued") && !message.content && <span className="tool-activity-live text-ink-faint">Thinking</span>}
      </p>
      {failed ? (
        <div role="alert" className="mt-2 rounded-md border border-error/60 bg-error/10 px-3 py-2.5 text-sm leading-relaxed text-error">
          {message.content || "The response could not be completed."}
        </div>
      ) : message.content ? <ChatMarkdown>{message.content}</ChatMarkdown> : null}
    </div>
  );
}

function TaskChat({ taskId, events, column, hasSession }: { taskId: string; events: TaskEvent[]; column: string; hasSession: boolean }) {
  const [messages, setMessages] = useState<TaskChatMessage[]>(() => chatMessages(events));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const displayedMessages = useMemo(() => {
    const persisted = chatMessages(events);
    const persistedClientKeys = new Set(persisted
      .filter((message) => message.clientMessageId)
      .map((message) => `${message.role}:${message.clientMessageId}`));
    return [...persisted, ...messages.filter((message) => !message.clientMessageId || !persistedClientKeys.has(`${message.role}:${message.clientMessageId}`))];
  }, [events, messages]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTo({ top: transcript.scrollHeight, behavior: "smooth" });
  }, [displayedMessages]);

  async function send() {
    const content = input.trim();
    if (!content || busy || column === "working" || column === "blocked" || column === "approval") return;
    setInput(""); setError(null); setBusy(true);
    const localId = `local-${Date.now()}`;
    setMessages((current) => [...current, { id: localId, role: "user", content, clientMessageId: localId }, { id: `${localId}-reply`, role: "assistant", content: "", status: "queued", clientMessageId: localId }]);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: content, clientMessageId: localId }) });
      if (!response.ok) throw new Error((await response.json().catch(() => null) as { error?: string } | null)?.error ?? "Chat is unavailable.");
      return;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setMessages((current) => current.map((message) => message.id === `${localId}-reply` ? { ...message, status: "failed", content: "The agent could not answer." } : message));
    } finally { setBusy(false); }
  }

  const available = hasSession && column !== "working" && column !== "approval" && column !== "blocked";
  const unavailableCopy = !hasSession
      ? "Dispatch the task to start an agent session before chatting."
      : column === "working"
        ? "The agent is still running. Chat opens when this turn finishes."
        : "Resolve the pending action above before continuing this session.";

  return (
    <section aria-labelledby="task-chat-heading">
      <h2 id="task-chat-heading" className="text-xl font-semibold tracking-[-0.025em] text-ink">Chat with the agent</h2>

      <div className="mt-4 overflow-hidden rounded-lg border border-line bg-panel/40">
        <div ref={transcriptRef} className="scrollbar-none min-h-[360px] max-h-[min(58vh,620px)] space-y-7 overflow-y-auto px-5 py-7 sm:px-8">
          {displayedMessages.length > 0 ? displayedMessages.map((message) => message.role === "user" ? (
            <div key={message.id} className="flex justify-end">
              <div className="max-w-[85%] text-right">
                <p className="mb-1 font-mono text-[8px] uppercase tracking-[0.2em] text-ink-faint">You</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{message.content}</p>
              </div>
            </div>
          ) : (
            <TaskChatAssistantMessage key={message.id} message={message} busy={busy} />
          )) : (
            <div className="flex min-h-[300px] items-center justify-center text-center">
              <div className="max-w-sm">
                <span className="mx-auto flex h-10 w-10 items-center justify-center rounded-full border border-line-strong bg-panel-hi text-signal">
                  <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true"><path d="M3.5 4.5h11v8H8l-3 2v-2H3.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M6.5 7h5M6.5 9.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
                </span>
                <p className="mt-4 text-sm font-semibold text-ink">Continue where the task left off</p>
                <p className="mt-1.5 text-xs leading-5 text-ink-faint">Ask for a summary, challenge a finding, or request a refinement.</p>
              </div>
            </div>
          )}
        </div>

        <div className="px-3 pb-3 pt-3 sm:px-4 sm:pb-4 sm:pt-4">
          {available ? (
            <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="signal-glow mx-auto flex flex-col rounded-2xl border border-line-strong bg-panel-hi px-4 pb-3 pt-3 focus-within:border-signal/60">
              <label htmlFor="task-chat-input" className="sr-only">Message this agent</label>
              <textarea
                id="task-chat-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                disabled={busy}
                rows={2}
                placeholder={busy ? "The agent is thinking…" : "Ask a follow-up about this task"}
                className="scrollbar-none min-h-[58px] w-full resize-none border-0 bg-transparent px-2 text-sm leading-6 text-ink outline-none placeholder:text-ink-faint disabled:opacity-50"
              />
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-ink-faint">Enter to send</span>
                <span className="hidden text-[10px] text-ink-faint sm:inline">Shift + Enter for a new line</span>
                <button type="submit" disabled={busy || !input.trim()} className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-signal text-deck transition-transform hover:scale-[1.03] disabled:opacity-25" aria-label="Send message">
                  <svg viewBox="0 0 20 20" className="h-4 w-4" aria-hidden="true"><path d="m4 10 11-6-3.3 12-2-4.2L4 10Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /><path d="m9.7 11.8 2-2.2" stroke="currentColor" strokeWidth="1.6" /></svg>
                </button>
              </div>
            </form>
          ) : (
            <p className="text-xs text-ink-faint">{unavailableCopy}</p>
          )}
          {error && <p className="mt-3 text-xs text-state-blocked" role="alert">{error}</p>}
        </div>
      </div>
    </section>
  );
}

function chatMessages(events: TaskEvent[]): TaskChatMessage[] {
  return events.flatMap((event) => {
    if (event.type !== "chat.user" && event.type !== "chat.assistant") return [];
    const payload = parsePayload(event.payload);
    return typeof payload?.content === "string" ? [{ id: event.id, role: event.type === "chat.user" ? "user" : "assistant", content: payload.content, status: typeof payload.status === "string" ? payload.status : undefined, clientMessageId: typeof payload.clientMessageId === "string" ? payload.clientMessageId : undefined }] : [];
  });
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

function ActivitySection({ items, liveTool }: { items: ActivityItem[]; liveTool: LiveTool | null }) {
  const feedRef = useRef<HTMLDivElement>(null);
  const groups = groupConsecutiveSpecialistTools(items);

  useEffect(() => {
    const feed = feedRef.current;
    if (feed) feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }, [items.length, liveTool?.phase, liveTool?.toolCallId]);

  return (
    <section>
      <SectionHeading eyebrow={`${items.length} meaningful events`} title="Activity" />
      {liveTool && <LiveToolActivity tool={liveTool} />}
      <div className={`${liveTool ? "mt-3" : "mt-4"} rounded-lg border border-line bg-panel/40`}>
        <div ref={feedRef} className="h-80 overflow-y-auto overscroll-contain px-4 sm:px-5">
          {groups.length > 0 ? (
            <ol>
              {groups.map((group, index) => {
                const connected = index < groups.length - 1;
                if (group.type === "tools") {
                  return (
                    <ActivityToolGroup
                      key={group.items[0].id}
                      items={group.items}
                      connected={connected}
                      liveTool={liveTool}
                    />
                  );
                }
                return <ActivityEvent key={group.item.id} item={group.item} connected={connected} />;
              })}
            </ol>
          ) : (
            <p className="py-5 text-sm text-ink-faint">No human-readable activity has been recorded yet.</p>
          )}
        </div>
      </div>
    </section>
  );
}

function ActivityEvent({ item, connected }: { item: ActivityItem; connected: boolean }) {
  return (
    <li className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-3 border-b border-line/70 py-4 last:border-b-0">
      {connected && <span className="absolute left-[6px] top-6 h-[calc(100%-12px)] w-px bg-line-strong" />}
      <span className={`relative z-10 mt-1 h-3 w-3 rounded-full border-2 border-panel ${activityDot(item.tone)}`} />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {item.kind === "narration" ? (
            <p className="font-mono text-[8px] font-semibold uppercase tracking-[0.16em] text-state-working">Agent update</p>
          ) : (
            <p className="text-sm font-semibold text-ink">{item.title}</p>
          )}
          <time className="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">{formatEventTime(item.at)}</time>
        </div>
        {item.detail && (item.kind === "narration" ? (
          <div className="mt-2">
            <ChatMarkdown>{item.detail}</ChatMarkdown>
          </div>
        ) : (
          <p className="mt-1 whitespace-pre-wrap text-xs leading-6 text-ink-soft">{item.detail}</p>
        ))}
      </div>
    </li>
  );
}

function ActivityToolGroup({ items, connected, liveTool }: { items: ActivityItem[]; connected: boolean; liveTool: LiveTool | null }) {
  const latest = items[items.length - 1];
  const liveItem = items.find((item) => Boolean(
    item.toolPhase === "started" && item.toolCallId && item.toolCallId === liveTool?.toolCallId,
  ));
  const display = liveItem ?? latest;
  const live = Boolean(liveItem);
  const extra = items.length > 1 ? ` + ${items.length - 1}` : "";

  return (
    <li className="relative grid grid-cols-[14px_minmax(0,1fr)] gap-3 border-b border-line/70 py-4 last:border-b-0">
      {connected && <span className="absolute left-[6px] top-6 h-[calc(100%-12px)] w-px bg-line-strong" />}
      <span className={`relative z-10 mt-1 h-3 w-3 rounded-full border-2 border-panel ${activityDot("working")} ${live ? "led-live" : ""}`} />
      <details className="group min-w-0">
        <summary className="flex cursor-pointer list-none items-baseline gap-2 marker:content-none [&::-webkit-details-marker]:hidden">
          <span className={`min-w-0 flex-1 truncate font-mono text-[10px] text-ink-soft ${live ? "tool-activity-live" : ""}`}>
            {live ? "Using" : "Used"} {toolLabel(display.toolName ?? "tool")}{extra}
          </span>
          <time className="shrink-0 font-mono text-[8px] uppercase tracking-[0.1em] text-ink-faint">{formatEventTime(latest.at)}</time>
          <svg className="h-3 w-3 shrink-0 text-ink-faint transition-transform group-open:rotate-180" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </summary>
        <ul className="mt-3 space-y-2 border-l border-line pl-3">
          {items.map((item) => {
            const itemLive = Boolean(item.toolPhase === "started" && item.toolCallId && item.toolCallId === liveTool?.toolCallId);
            return (
              <li key={item.id} className="flex min-w-0 items-start gap-2 font-mono text-[10px] leading-relaxed text-ink-soft">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${itemLive ? "bg-signal led-live" : "border border-line-strong bg-deck"}`} aria-hidden="true" />
                <code className={`min-w-0 break-all ${itemLive ? "tool-activity-live" : ""}`}>{item.toolName ?? "tool"}</code>
              </li>
            );
          })}
        </ul>
      </details>
    </li>
  );
}

function Dependencies({ items }: { items: Predecessor[] }) {
  return (
    <InfoCard title={items.length === 1 ? "Parent task" : "Parent tasks"} suffix={String(items.length)}>
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

function activityItemsFromEvents(events: TaskEvent[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const toolIndexes = new Map<string, number>();
  for (const event of events) {
    if (!event.type.startsWith("activity.")) continue;
    const item = semanticActivityFromEvent(event);
    if (!item) continue;
    if (item.kind === "tool" && item.toolCallId) {
      const existingIndex = toolIndexes.get(item.toolCallId);
      if (existingIndex !== undefined) {
        const existing = items[existingIndex];
        items[existingIndex] = { ...existing, ...item, id: existing.id, at: existing.at };
        continue;
      }
      toolIndexes.set(item.toolCallId, items.length);
    }
    items.push(item);
  }
  return items;
}

function semanticActivityFromEvent(event: TaskEvent): ActivityItem | null {
  const payload = parsePayload(event.payload);
  if (event.type === "activity.narration") {
    if (typeof payload?.content !== "string" || !payload.content.trim()) return null;
    return {
      id: event.id,
      at: event.createdAt,
      title: "Agent update",
      detail: concise(payload.content, 1_200),
      tone: "working",
      kind: "narration",
    };
  }
  if (event.type === "activity.tool") {
    const name = typeof payload?.name === "string" ? payload.name : "tool";
    const phase = payload?.phase === "completed" ? "completed" : "started";
    return {
      id: event.id,
      at: event.createdAt,
      title: `${phase === "completed" ? "Used" : "Using"} ${toolLabel(name)}`,
      detail: typeof payload?.message === "string" ? concise(payload.message) : undefined,
      tone: "working",
      kind: "tool",
      toolCallId: typeof payload?.toolCallId === "string" ? payload.toolCallId : undefined,
      toolName: name,
      toolPhase: phase,
    };
  }
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
    kind: "status",
  };
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

function latestSpecialistTool(events: TaskEvent[], runId?: string | null): LiveTool | null {
  const active = new Map<string, LiveTool>();
  let latest: LiveTool | null = null;
  for (const event of events) {
    if (event.type !== "activity.tool") continue;
    const payload = parsePayload(event.payload);
    if (!payload || typeof payload.name !== "string") continue;
    if (runId && payload.runId !== runId) continue;
    const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : undefined;
    const phase = payload.phase === "completed" ? "completed" : "started";
    latest = { name: payload.name, at: event.createdAt, toolCallId, phase };
    if (!toolCallId) continue;
    if (phase === "completed") active.delete(toolCallId);
    else active.set(toolCallId, latest);
  }
  return [...active.values()].at(-1) ?? latest;
}

function LiveToolActivity({ tool }: { tool: LiveTool }) {
  return (
    <div aria-live="polite" className="flex items-center gap-2 px-1 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-faint">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal led-live" aria-hidden="true" />
      <span className="tool-activity-live">{tool.phase === "completed" ? "Working" : `Using ${tool.name}`}</span>
    </div>
  );
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
