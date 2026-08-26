import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { convexUrl } from "./queue/env";

const convexFunctions = api as unknown as Record<string, Record<string, any>>;
let client: ConvexHttpClient | undefined;

function convex(): ConvexHttpClient {
  return (client ??= new ConvexHttpClient(convexUrl(), { logger: false }));
}

function functionRef(moduleName: string, name: string): any {
  const module = convexFunctions[moduleName];
  if (!module?.[name]) throw new Error(`Convex function unavailable: ${moduleName}.${name}`);
  return module[name];
}

function id(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record._id === "string") return record._id;
    if (typeof record.id === "string") return record.id;
  }
  return String(value ?? "");
}

function date(value: unknown): string {
  if (typeof value === "number") return new Date(value).toISOString();
  if (typeof value === "string") return value;
  return new Date(0).toISOString();
}

function nullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function outputText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return value == null ? null : String(value);
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (typeof record.text === "string") return record.text;
  return JSON.stringify(value);
}

function payloadText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value ?? {});
}

function normalizeActions(value: unknown, selector?: string | null): unknown[] | null {
  let source = value;
  if (typeof source === "string") {
    try { source = JSON.parse(source); } catch { return null; }
  }
  if (!Array.isArray(source)) return null;
  const actions = source.flatMap((raw) => {
    if (!raw || typeof raw !== "object") return [];
    const action = raw as Record<string, unknown>;
    if (typeof action.type !== "string") return [];
    const threadId = typeof action.threadId === "string" || action.threadId === null ? action.threadId : null;
    const rawCalls = Array.isArray(action.calls) ? action.calls : Array.isArray(action.toolCalls) ? action.toolCalls : [];
    const calls = rawCalls.flatMap((rawCall) => {
      if (!rawCall || typeof rawCall !== "object") return [];
      const call = rawCall as Record<string, unknown>;
      if (typeof call.id !== "string") return [];
      return [{
        id: call.id,
        threadId: typeof call.threadId === "string" || call.threadId === null ? call.threadId : threadId,
        ...(typeof call.name === "string" ? { name: call.name } : {}),
        ...(typeof call.args === "string" ? { args: call.args } : {}),
      }];
    });
    const actionSelector = typeof action.selector === "string" ? action.selector : selector ?? undefined;
    return [{ type: action.type, ...(actionSelector ? { selector: actionSelector } : {}), threadId, calls }];
  });
  return actions;
}

function normalizeRun(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Record<string, unknown>;
  return {
    id: id(run),
    status: typeof run.status === "string" ? run.status : null,
    sessionId: typeof run.sessionId === "string" ? run.sessionId : null,
    turnId: typeof run.turnId === "string" ? run.turnId : null,
    attempt: typeof run.attempt === "number" ? run.attempt : null,
    updatedAt: date(run.updatedAt),
    createdAt: date(run.createdAt),
    finishedAt: run.finishedAt == null ? null : date(run.finishedAt),
    errorCode: typeof run.errorCode === "string" ? run.errorCode : null,
    errorMessage: typeof run.errorMessage === "string" ? run.errorMessage : null,
  };
}

function columnFor(taskColumn: unknown, runStatus: unknown): string {
  const column = typeof taskColumn === "string" ? taskColumn : "backlog";
  switch (runStatus) {
    case "queued":
    case "enqueued":
    case "connecting":
    case "running": return "working";
    case "waiting_for_approval": return "approval";
    case "waiting_for_user": return "blocked";
    case "failed": return "blocked";
    case "cancelled": return "backlog";
    case "completed": return "settled";
    default: return column;
  }
}

/** Read one Convex task and adapt it to the legacy task-detail view contract. */
export async function getDurableTaskDetail(taskId: string): Promise<Record<string, unknown> | null> {
  const [rawTask, context, activeRun, latestRun] = await Promise.all([
    convex().query(functionRef("missions", "getTask"), { taskId: taskId as never, eventLimit: 2000, documentLimit: 500 }),
    convex().query(functionRef("missions", "getTaskDispatchContext"), { taskId: taskId as never }),
    convex().query(functionRef("agentRuns", "activeForTask"), { taskId: taskId as never }),
    convex().query(functionRef("agentRuns", "latestForTask"), { taskId: taskId as never }),
  ]);
  if (!rawTask || typeof rawTask !== "object") return null;

  const task = rawTask as Record<string, unknown>;
  const dispatch = context && typeof context === "object" ? context as Record<string, unknown> : {};
  const mission = dispatch.mission && typeof dispatch.mission === "object" ? dispatch.mission as Record<string, unknown> : null;
  const runRaw = activeRun && typeof activeRun === "object" ? activeRun : latestRun;
  const run = runRaw && typeof runRaw === "object" ? runRaw as Record<string, unknown> : null;
  const runStatus = run?.status;
  const actionSource = run?.pendingActions ?? task.pendingActions;
  const pendingActions = normalizeActions(actionSource, typeof run?.pendingActionSelector === "string" ? run.pendingActionSelector : null);
  const predecessors = Array.isArray(dispatch.predecessors) ? dispatch.predecessors.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    return [{ id: id(item), title: String(item.title ?? ""), column: String(item.column ?? "backlog"), role: String(item.role ?? "") }];
  }) : [];
  const documents = Array.isArray(task.documents) ? task.documents.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    return [{ id: id(item), title: String(item.title ?? ""), updatedAt: date(item.updatedAt), authorRole: String(item.authorRole ?? "unknown"), kind: String(item.kind ?? "artifact") }];
  }) : [];
  const events = Array.isArray(task.events) ? task.events.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const event = value as Record<string, unknown>;
    return [{ id: id(event), seq: Number(event.seq ?? 0), type: String(event.type ?? "unknown"), payload: payloadText(event.payload), createdAt: date(event.createdAt) }];
  }) : [];

  const taskOutput = outputText(task.output);
  const runOutput = outputText(run?.output);
  const taskError = typeof task.error === "string" ? task.error : null;
  const runError = typeof run?.errorMessage === "string" ? run.errorMessage : null;
  const taskSession = typeof task.sessionId === "string" ? task.sessionId : null;
  const runSession = typeof run?.sessionId === "string" ? run.sessionId : null;
  const taskTurn = typeof task.turnId === "string" ? task.turnId : null;
  const runTurn = typeof run?.turnId === "string" ? run.turnId : null;

  return {
    id: id(task),
    title: String(task.title ?? task.name ?? "Untitled task"),
    detail: nullableString(task.detail ?? task.description),
    role: String(task.role ?? ""),
    agentPrompt: nullableString(task.agentPrompt),
    agentInstructions: nullableString(task.agentPrompt),
    column: columnFor(task.column, runStatus),
    sessionId: taskSession ?? runSession,
    turnId: taskTurn ?? runTurn,
    dependsOn: JSON.stringify(Array.isArray(task.dependsOn) ? task.dependsOn.map(String) : []),
    handoff: nullableString(task.handoff),
    output: taskOutput ?? runOutput,
    error: taskError ?? runError,
    pendingActions: pendingActions ? JSON.stringify(pendingActions) : null,
    createdAt: date(task.createdAt),
    updatedAt: date(task.updatedAt),
    mission: mission ? { id: id(mission), title: String(mission.title ?? ""), goal: String(mission.goal ?? "") } : { id: "", title: "", goal: "" },
    predecessors,
    documents,
    events,
    mode: "durable",
    runId: run ? id(run) : null,
    runStatus: typeof runStatus === "string" ? runStatus : null,
    run: normalizeRun(run),
  };
}

export type DurableTaskActionResult = { ok: boolean; reason?: string };

export function durableTaskActionResponse(taskId: string, action: string, result: DurableTaskActionResult, detail: Record<string, unknown> | null) {
  const run = detail?.run && typeof detail.run === "object" ? detail.run as Record<string, unknown> : null;
  return {
    mode: "durable",
    action,
    ok: result.ok,
    taskId,
    ...(!result.ok ? { error: result.reason ?? "action_rejected", code: result.reason ?? "action_rejected" } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    status: detail?.runStatus ?? null,
    column: detail?.column ?? null,
    runId: detail?.runId ?? null,
    runStatus: detail?.runStatus ?? null,
    run: run ?? null,
  };
}
EOF