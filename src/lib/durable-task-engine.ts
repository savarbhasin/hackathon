import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { convexUrl } from "./queue/env";
import { enqueueAdmittedResume, enqueueAdmittedRun } from "./queue/producer";
import { dependencyIds } from "./task-graph";

// Convex's generated API is intentionally allowed to lag during the migration.
// Runtime api is anyApi, while this cast keeps the web server build usable before
// the next `convex dev` codegen pass lands.
const convexApi = api as any;
let client: ConvexHttpClient | undefined;

function convex(): ConvexHttpClient {
  return client ??= new ConvexHttpClient(convexUrl(), { logger: false });
}

function id(value: any): string {
  return String(value?._id ?? value?.id ?? value);
}

function truncate(value: unknown, cap = 4000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null) ?? "";
  return text.length <= cap ? text : `${text.slice(0, cap)}…[truncated]`;
}

function operationHash(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null) ?? "";
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

/** Durable operation-keyed task activity. This never uses a process-local queue. */
export async function appendDurableTaskEvent(
  taskId: string,
  type: string,
  payload: unknown,
  operationKey?: string,
): Promise<unknown> {
  const key = operationKey ?? `event:${type}:${operationHash(payload)}`;
  return await convex().mutation(convexApi.missions.appendTaskEvent, {
    taskId,
    type,
    payload,
    operationKey: key,
  });
}

type DispatchContext = {
  mission: { _id: string; title: string; goal: string; status?: string };
  task: Record<string, any> & { _id: string; title: string; role: string; column: string };
  predecessors: Array<{
    id: string;
    title: string;
    role: string;
    column: string;
    summary: string | null;
    documents: Array<{ id: string; title: string; content?: string; kind?: string }>;
  }>;
  successors: Array<{ id: string; title: string; role: string }>;
};

function asContext(value: any): DispatchContext | null {
  if (!value?.mission || !value?.task) return null;
  return {
    ...value,
    mission: { ...value.mission, _id: id(value.mission) },
    task: { ...value.task, _id: id(value.task) },
    predecessors: Array.isArray(value.predecessors) ? value.predecessors.map((item: any) => ({
      ...item,
      id: id(item),
      documents: Array.isArray(item.documents) ? item.documents.map((doc: any) => ({ ...doc, id: id(doc) })) : [],
    })) : [],
    successors: Array.isArray(value.successors) ? value.successors.map((item: any) => ({ ...item, id: id(item) })) : [],
  };
}

function buildDurableKickoff(context: DispatchContext): string {
  const { mission, task } = context;
  const parts = [
    `MISSION: ${mission.title}`,
    mission.goal,
    "",
    `YOUR ASSIGNMENT: ${task.title}`,
    task.detail,
    "",
    `TASK_ID: ${task._id}`,
  ];

  if (context.predecessors.length === 0) {
    parts.push("", "PREDECESSORS: None. You may begin without waiting for another task.");
  } else {
    parts.push("", "PREDECESSOR CONTEXT:");
    for (const predecessor of context.predecessors) {
      parts.push(`- ${predecessor.title} [${predecessor.role}] (RELATED_ID: ${predecessor.id}, STATUS: ${predecessor.column})`);
      if (predecessor.summary) parts.push(`  Completion summary: ${truncate(predecessor.summary, 1200)}`);
      if (predecessor.documents.length === 0) {
        parts.push("  Handoff documents: none attached.");
      } else {
        parts.push("  Handoff documents:");
        for (const document of predecessor.documents) parts.push(`  - ${document.title} (DOC_ID: ${document.id})`);
      }
    }
    const documentCount = context.predecessors.reduce((count, predecessor) => count + predecessor.documents.length, 0);
    if (documentCount > 0) {
      parts.push("Required startup step: call get_doc for every DOC_ID above before doing dependent work.");
    } else {
      parts.push("No handoff document was attached. Use the completion summaries only for limited context. If your assignment requires missing predecessor material, ask one precise question instead of inventing it.");
    }
  }

  if (context.successors.length > 0) {
    parts.push("", "DOWNSTREAM SUCCESSORS THAT DEPEND ON YOUR OUTPUT:");
    for (const successor of context.successors) parts.push(`- ${successor.title} [${successor.role}] (RELATED_ID: ${successor.id})`);
    parts.push("Before mark_done, create a self-contained document with kind=\"handoff\" if these successors need substantial context, evidence, decisions, or finished material from you. Verify the create_doc response says kind=handoff and include its DOC_ID in your completion summary.");
  } else {
    parts.push("", "DOWNSTREAM SUCCESSORS: None are recorded at dispatch time. Follow any downstream handoff requirement in YOUR ASSIGNMENT. Otherwise use kind=\"artifact\" for durable human-readable work.");
  }

  parts.push(
    "",
    "EXECUTION RULES:",
    "- Treat the mission as context and YOUR ASSIGNMENT as the exact scope.",
    "- Use supplied inputs and readable handoff documents before asking the user for information.",
    "- Do not invent missing facts, IDs, document contents, tool results, or completed actions.",
    "- If a required tool or input remains unavailable after safe checks, ask one precise question that explains the blocker.",
    "- Call mark_done exactly once, only after the deliverable exists and required checks or approval-gated actions have reached a real outcome.",
    "",
    "Begin work now.",
  );
  return parts.join("\n");
}

function identity(context: DispatchContext, retry = false): { externalId: string; operationKey: string } {
  const taskId = context.task._id;
  const claim = Number(context.task.claimCount) + (retry ? 1 : 0);
  if (retry || claim > 1) {
    return { externalId: `specialist:${taskId}:retry:${claim}`, operationKey: `admission:${taskId}:retry:${claim}` };
  }
  return { externalId: `specialist:${taskId}`, operationKey: `admission:${taskId}:initial` };
}

function admissionError(value: any): string {
  return value?.reason ? String(value.reason) : value?.kind ? String(value.kind) : "admission_rejected";
}

async function enqueue(run: any): Promise<{ ok: boolean; reason?: string }> {
  if (!run?._id) return { ok: false, reason: "admission_missing_run" };
  if (!["queued", "enqueued"].includes(String(run.status))) return { ok: false, reason: `run_not_queueable:${run.status ?? "unknown"}` };
  try {
    const delivery = await enqueueAdmittedRun(id(run));
    if (delivery.kind === "already_present" && delivery.state === "failed") {
      return { ok: false, reason: "enqueue_failed:existing_failed_delivery" };
    }
    return { ok: true };
  } catch (error) {
    // Convex admission is canonical; leave the run queued for reconciliation.
    return { ok: false, reason: `enqueue_failed:${truncate(String(error), 300)}` };
  }
}

export async function durableDispatchTask(taskId: string, retry = false): Promise<{ ok: boolean; reason?: string }> {
  const raw = await convex().query(convexApi.missions.getTaskDispatchContext, { taskId });
  const context = asContext(raw);
  if (!context) return { ok: false, reason: "not_found" };
  if (context.task.column !== "backlog") return { ok: false, reason: `column=${context.task.column}` };
  if (context.task.sessionId !== undefined) return { ok: false, reason: "already_dispatched" };

  const identityValue = identity(context, retry);
  const admission = await convex().mutation(convexApi.missions.admitSpecialist, {
    taskId: context.task._id,
    externalId: identityValue.externalId,
    operationKey: identityValue.operationKey,
    kickoffInput: { agentName: context.task.role, items: [{ type: "user.message", content: buildDurableKickoff(context) }] },
    owner: `web:${process.pid}`,
  });
  if (!admission || !["created", "idempotent"].includes(String(admission.kind))) return { ok: false, reason: admissionError(admission) };
  const delivery = await enqueue(admission.run);
  if (!delivery.ok) {
    try {
      await appendDurableTaskEvent(context.task._id, "activity.enqueue_failed", {
        title: "Agent queued state needs reconciliation",
        runId: id(admission.run),
        message: delivery.reason,
      }, `enqueue:${id(admission.run)}`);
    } catch {
      // The queued run remains the source of truth even if activity logging fails.
    }
  }
  return delivery;
}

export async function durableFollowupTask(taskId: string, message: string, clientMessageId?: string): Promise<{ ok: boolean; reason?: string; runId?: string }> {
  const raw = await convex().query(convexApi.missions.getTaskDispatchContext, { taskId });
  const context = asContext(raw);
  if (!context) return { ok: false, reason: "not_found" };
  const key = clientMessageId?.trim() || operationHash(message);
  const externalId = `specialist:${context.task._id}:followup:${key}`;
  const admission = await convex().mutation(convexApi.missions.admitFollowup, {
    taskId: context.task._id,
    externalId,
    operationKey: `admission:${externalId}`,
    input: { agentName: context.task.role, followup: true, clientMessageId: clientMessageId ?? null, items: [{ type: "user.message", content: message }] },
    owner: `web:${process.pid}`,
  });
  if (!admission || !["created", "idempotent"].includes(String(admission.kind))) return { ok: false, reason: admissionError(admission) };
  const runId = id(admission.run);
  if (!runId) return { ok: false, reason: "admission_missing_run" };
  if (String(admission.kind) === "idempotent" && !["queued", "enqueued"].includes(String(admission.run?.status))) {
    return { ok: true, runId };
  }
  const delivery = await enqueue(admission.run);
  if (!delivery.ok) return { ...delivery, runId };
  return { ok: true, runId };
}

export async function durableRetryTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const raw = await convex().query(convexApi.missions.getTaskDispatchContext, { taskId });
  const context = asContext(raw);
  if (!context) return { ok: false, reason: "not_found" };
  if (context.task.column !== "blocked") return { ok: false, reason: `column=${context.task.column}` };

  const run = context.task.specialistRunId
    ? await convex().query(convexApi.agentRuns.get, { runId: context.task.specialistRunId })
    : null;
  const otherActiveRun = context.task.activeRunId && context.task.activeRunId !== context.task.specialistRunId
    ? await convex().query(convexApi.agentRuns.get, { runId: context.task.activeRunId })
    : null;
  if (otherActiveRun && !["failed", "cancelled", "completed"].includes(String(otherActiveRun.status))) return { ok: false, reason: "run_active" };
  if (run?.status === "waiting_for_user") return { ok: false, reason: "question_pending" };
  if (run?.status === "waiting_for_approval") return { ok: false, reason: "approval_pending" };
  if (run && ["queued", "enqueued", "connecting", "running"].includes(String(run.status))) return { ok: false, reason: "run_active" };
  if (run?.status === "completed") return { ok: false, reason: "run_completed" };

  if (!run) return { ok: false, reason: "no_specialist_run" };

  const expectedSessionId = context.task.sessionId ?? run.sessionId;
  const expectedTurnId = context.task.turnId ?? run.turnId;
  const reset = await convex().mutation(convexApi.missions.resetSpecialistForRetry, {
    taskId: context.task._id,
    expectedSpecialistRunId: id(run),
    ...(expectedSessionId !== undefined ? { expectedSessionId } : {}),
    ...(expectedTurnId !== undefined ? { expectedTurnId } : {}),
    operationKey: `retry-reset:${context.task._id}:${id(run)}`,
  });
  if (!reset || reset.kind !== "ok") {
    if (!reset) return { ok: false, reason: "retry_reset_failed" };
    if (reset.kind === "not_found") return { ok: false, reason: "not_found" };
    if (reset.kind === "conflict") return { ok: false, reason: `conflict:${reset.reason ?? "retry_reset"}` };
    if (reset.kind === "invalid_state") return { ok: false, reason: `invalid_state:${reset.reason ?? "retry_reset"}` };
    if (reset.kind === "dependency_blocked") return { ok: false, reason: `dependency_blocked:${reset.reason ?? "retry_reset"}` };
    return { ok: false, reason: `retry_reset_rejected:${reset.kind}` };
  }
  const refreshed = asContext(await convex().query(convexApi.missions.getTaskDispatchContext, { taskId }));
  if (!refreshed || refreshed.task.column !== "backlog") return { ok: false, reason: "retry_reset_failed" };
  if (refreshed.task.sessionId !== undefined || refreshed.task.turnId !== undefined || refreshed.task.specialistRunId !== undefined || refreshed.task.activeRunId !== undefined) {
    return { ok: false, reason: "retry_reset_failed:linkage_not_cleared" };
  }
  return await durableDispatchTask(taskId, true);
}

type PendingCall = {
  id: string;
  threadId?: string | null;
  selectorValues: Set<string>;
};

function actionCalls(action: any): PendingCall[] {
  const calls = Array.isArray(action?.calls) ? action.calls : action?.toolCalls;
  if (!Array.isArray(calls)) return [];
  return calls.flatMap((call: any) => {
    if (typeof call?.id !== "string") return [];
    const selectorValues = new Set<string>();
    for (const key of ["selector", "id", "toolCallId", "sourceEventId"]) {
      if (typeof call?.[key] === "string" && call[key]) selectorValues.add(call[key]);
    }
    for (const key of ["selector", "id", "toolCallId", "sourceEventId"]) {
      if (typeof action?.[key] === "string" && action[key]) selectorValues.add(action[key]);
    }
    return [{ id: call.id, threadId: call.threadId ?? action.threadId ?? null, selectorValues }];
  });
}

export async function durableResolvePause(
  taskId: string,
  decision: { kind: "approve"; allow: boolean; reason?: string; selector?: string } | { kind: "answer"; content: string; selector?: string },
): Promise<{ ok: boolean; reason?: string }> {
  const raw = await convex().query(convexApi.missions.getTaskDispatchContext, { taskId });
  const context = asContext(raw);
  if (!context?.task.specialistRunId) return { ok: false, reason: "no_session" };
  const run = await convex().query(convexApi.agentRuns.get, { runId: context.task.specialistRunId });
  if (!run || (run.status !== "waiting_for_user" && run.status !== "waiting_for_approval")) return { ok: false, reason: "nothing_pending" };

  const actions = Array.isArray(run.pendingActions) ? run.pendingActions : Array.isArray(context.task.pendingActions) ? context.task.pendingActions : [];
  const selector = decision.selector?.trim();
  if (!selector) return { ok: false, reason: "selector_required" };

  const matches: Array<{ action: any; call: PendingCall }> = [];
  for (const action of actions) {
    for (const call of actionCalls(action)) {
      if (call.selectorValues.has(selector)) matches.push({ action, call });
    }
  }
  if (matches.length !== 1) return { ok: false, reason: "selector_mismatch" };
  const match = matches[0];
  if (match.action.type === "mcp.auth_required") return { ok: false, reason: "connector_auth_required" };
  const expectedDecision = run.status === "waiting_for_approval" ? "approve" : "answer";
  const expectedAction = run.status === "waiting_for_approval" ? "tool.approval_required" : "tool.response_required";
  if (decision.kind !== expectedDecision || match.action.type !== expectedAction) return { ok: false, reason: "decision_mismatch" };

  const resumeItem = decision.kind === "approve"
    ? { type: "user.tool_approval", threadId: match.call.threadId, toolCallId: match.call.id, approval: decision.allow ? { status: "allow" } : { status: "deny", reason: decision.reason ?? "denied by user" } }
    : { type: "user.tool_response", threadId: match.call.threadId, toolCallId: match.call.id, content: decision.content };
  const operationKey = `resume:${id(run)}:${selector}:${decision.kind}:${decision.kind === "approve" ? decision.allow : operationHash(decision.content)}`;
  const admission = await convex().mutation(convexApi.missions.resumeSpecialist, {
    taskId: context.task._id,
    runId: id(run),
    selector,
    decisionType: decision.kind,
    resumeInput: [resumeItem],
    operationKey,
  });
  if (!admission || !["created", "idempotent"].includes(String(admission.kind))) return { ok: false, reason: admissionError(admission) };
  return await enqueueResume(id(run));
}

async function enqueueResume(runId: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const delivery = await enqueueAdmittedResume(runId);
    if (delivery.kind === "already_present" && delivery.state === "failed") {
      return { ok: false, reason: "enqueue_failed:existing_failed_delivery" };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `enqueue_failed:${truncate(String(error), 300)}` };
  }
}

export async function durableSweep(): Promise<void> {
  const tasks = await convex().query(convexApi.missions.listTasks, { column: "backlog", limit: 2000 });
  if (!Array.isArray(tasks)) return;
  for (const item of tasks) {
    const context = asContext(await convex().query(convexApi.missions.getTaskDispatchContext, { taskId: id(item) }));
    if (!context || context.task.column !== "backlog") continue;
    const dependencies = dependencyIds(Array.isArray(context.task.dependsOn) ? JSON.stringify(context.task.dependsOn) : String(context.task.dependsOn ?? "[]"));
    if (dependencies.length > 0 && context.predecessors.some((predecessor) => predecessor.column !== "settled")) continue;
    await durableDispatchTask(context.task._id);
  }
}

export async function durableGetBoard(): Promise<any[]> {
  const board = await convex().query(convexApi.missions.listBoard, { limit: 500 });
  return Array.isArray(board) ? board : [];
}
