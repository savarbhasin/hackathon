import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { convexUrl } from "./queue/env";
import { durableDispatchTask, durableResolvePause, durableSweep, durableGetBoard } from "./durable-task-engine";

const convexApi = anyApi as any;
let client: ConvexHttpClient | undefined;

function convex(): ConvexHttpClient {
  return client ??= new ConvexHttpClient(convexUrl(), { logger: false });
}

function id(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as { _id?: unknown; id?: unknown };
    if (record._id !== undefined) return String(record._id);
    if (record.id !== undefined) return String(record.id);
  }
  return String(value ?? "");
}

function date(value: unknown): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : value == null ? null : String(value);
}

function hash(value: unknown): string {
  const input = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let result = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    result ^= input.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

function legacyTask(task: any): any {
  if (!task) return task;
  return {
    ...task,
    id: id(task),
    missionId: task.missionId == null ? task.missionId : id(task.missionId),
    dependsOn: JSON.stringify(Array.isArray(task.dependsOn) ? task.dependsOn.map(id) : []),
    pendingActions: task.pendingActions == null ? null : JSON.stringify(task.pendingActions),
    createdAt: date(task.createdAt),
    updatedAt: date(task.updatedAt),
  };
}

function legacyDocument(document: any, mission?: any, task?: any): any {
  if (!document) return document;
  return {
    ...document,
    id: id(document),
    missionId: document.missionId == null ? document.missionId : id(document.missionId),
    taskId: document.taskId == null ? document.taskId : id(document.taskId),
    createdAt: date(document.createdAt),
    updatedAt: date(document.updatedAt),
    mission: mission ? { title: mission.title } : null,
    task: task ? { title: task.title, role: task.role } : null,
  };
}

export async function durableBoard(): Promise<any[]> {
  return await durableGetBoard();
}

export async function durableTask(taskId: string): Promise<any | null> {
  const task = await convex().query(convexApi.missions.getTask, { taskId });
  if (!task) return null;
  const normalized = legacyTask(task);
  if (Array.isArray(task.events)) {
    normalized.events = [...task.events]
      .sort((a: any, b: any) => Number(b.seq ?? 0) - Number(a.seq ?? 0))
      .slice(0, 20);
  }
  if (Array.isArray(task.documents)) normalized.documents = task.documents.map((document: any) => legacyDocument(document));
  return normalized;
}

export async function durableCreateMission(title: string, goal: string): Promise<any> {
  return await convex().mutation(convexApi.missions.createMission, {
    title,
    goal,
    status: "active",
    operationKey: `mcp:create_mission:${hash({ title: title.trim(), goal: goal.trim() })}`,
  });
}

export async function durableCreateTask(input: {
  missionId: string;
  title: string;
  detail: string;
  role: string;
  dependsOn: string[];
}): Promise<any> {
  const profile = await convex().query(convexApi.agentProfiles.getBySlug, { slug: input.role });
  if (!profile?.enabled) return { kind: "invalid_role", reason: `Unknown or disabled agent \"${input.role}\"` };
  return await convex().mutation(convexApi.missions.createTask, {
    missionId: input.missionId,
    title: input.title,
    detail: input.detail,
    role: profile.slug,
    dependsOn: input.dependsOn,
    operationKey: `mcp:create_task:${hash(input)}`,
  });
}

export async function durableMarkDone(input: { taskId: string; summary: string; handoff?: unknown }): Promise<any> {
  const task = await convex().query(convexApi.missions.getTask, { taskId: input.taskId });
  if (!task) return { kind: "not_found", reason: `Unknown task_id ${input.taskId}` };
  const runId = task.activeRunId ?? task.specialistRunId;
  if (!runId) return { kind: "invalid_state", reason: "no_specialist_run" };
  const stableRunId = id(runId);
  const result = await convex().mutation(convexApi.missions.markDone, {
    taskId: input.taskId,
    runId: stableRunId,
    summary: input.summary.trim(),
    operationKey: `mark_done:${stableRunId}`,
  });
  if ((result?.kind === "created" || result?.kind === "idempotent") && input.handoff !== undefined) {
    // markDone owns the single semantic completion event. Handoff is a task
    // projection only and deliberately does not emit a second event.
    await convex().mutation(convexApi.missions.updateTask, { taskId: input.taskId, handoff: input.handoff });
  }
  return result;
}

export async function durableCreateDoc(input: {
  taskId: string;
  title: string;
  content: string;
  kind: "artifact" | "handoff";
}): Promise<any> {
  const task = await convex().query(convexApi.missions.getTask, { taskId: input.taskId });
  if (!task) return { kind: "not_found", reason: `Unknown task_id ${input.taskId}` };
  return await convex().mutation(convexApi.documents.create, {
    taskId: input.taskId,
    missionId: task.missionId,
    title: input.title,
    content: input.content,
    kind: input.kind,
    authorRole: task.role,
    operationKey: `mcp:create_doc:${hash(input)}`,
  });
}

export async function durableUpdateDoc(input: {
  taskId: string;
  docId: string;
  title?: string;
  content?: string;
}): Promise<any> {
  const [task, existing] = await Promise.all([
    convex().query(convexApi.missions.getTask, { taskId: input.taskId }),
    convex().query(convexApi.documents.get, { documentId: input.docId }),
  ]);
  if (!task) return { kind: "not_found", reason: `Unknown task_id ${input.taskId}` };
  if (!existing || id(existing.taskId) !== input.taskId) return { kind: "not_found", reason: `No document ${input.docId} belongs to task ${input.taskId}` };
  return await convex().mutation(convexApi.documents.update, {
    documentId: input.docId,
    taskId: input.taskId,
    missionId: task.missionId,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
}

export async function durableSaveDocument(title: string, content: string): Promise<any> {
  const docs = await convex().query(convexApi.documents.list, { limit: 500 });
  const existing = Array.isArray(docs) ? docs.find((document: any) => document.title === title) : null;
  if (existing) return await convex().mutation(convexApi.documents.update, { documentId: id(existing), title, content });
  return await convex().mutation(convexApi.documents.save, {
    operationKey: `mcp:save_document:${hash(title.trim())}`,
    title,
    content,
    kind: "artifact",
    authorRole: "squad-lead",
  });
}

export async function durableListDocs(): Promise<any[]> {
  const docs = await convex().query(convexApi.documents.list, { limit: 500 });
  if (!Array.isArray(docs)) return [];
  const missionIds = [...new Set(docs.map((document: any) => document.missionId).filter(Boolean).map(id))];
  const taskIds = [...new Set(docs.map((document: any) => document.taskId).filter(Boolean).map(id))];
  const [missions, tasks] = await Promise.all([
    Promise.all(missionIds.map((missionId) => convex().query(convexApi.missions.getMission, { missionId }))),
    Promise.all(taskIds.map((taskId) => convex().query(convexApi.missions.getTask, { taskId }))),
  ]);
  const missionById = new Map(missions.filter(Boolean).map((mission: any) => [id(mission), mission]));
  const taskById = new Map(tasks.filter(Boolean).map((task: any) => [id(task), task]));
  return docs.map((document: any) => legacyDocument(document, missionById.get(id(document.missionId)), taskById.get(id(document.taskId))));
}

export async function durableGetDoc(docId: string): Promise<any | null> {
  const document = await convex().query(convexApi.documents.get, { documentId: docId });
  if (!document) return null;
  const [mission, task] = await Promise.all([
    document.missionId ? convex().query(convexApi.missions.getMission, { missionId: id(document.missionId) }) : null,
    document.taskId ? convex().query(convexApi.missions.getTask, { taskId: id(document.taskId) }) : null,
  ]);
  return legacyDocument(document, mission, task);
}

function legacySchedule(schedule: any): any {
  if (!schedule) return schedule;
  return {
    id: id(schedule),
    name: schedule.name,
    cronExpr: schedule.cronExpr,
    timezone: schedule.timezone ?? "UTC",
    // The existing MCP list_schedules contract includes prompt. Keep it in
    // the response, but never log it from the durable bridge.
    prompt: schedule.prompt,
    enabled: schedule.enabled,
    deletedAt: date(schedule.deletedAt),
    schedulerId: schedule.schedulerId,
    configRevision: schedule.configRevision,
    configHash: schedule.configHash,
    syncState: schedule.syncState,
    syncError: schedule.syncError,
    syncedAt: date(schedule.syncedAt),
    lastRunAt: date(schedule.lastRunAt),
    lastRunId: schedule.lastRunId == null ? schedule.lastRunId : id(schedule.lastRunId),
    lastRunStatus: schedule.lastRunStatus,
    lastIntendedFireAt: date(schedule.lastIntendedFireAt),
    lastFailureAt: date(schedule.lastFailureAt),
    lastFailureMessage: schedule.lastFailureMessage,
    createdAt: date(schedule.createdAt),
    updatedAt: date(schedule.updatedAt),
  };
}

export async function durableCreateSchedule(input: {
  name: string;
  cronExpr: string;
  prompt: string;
  requestId?: string | number;
  sessionId?: string;
}): Promise<any> {
  const requestId = input.requestId === undefined ? undefined : String(input.requestId);
  const operationKey = requestId
    ? `mcp:create_schedule:${input.sessionId?.trim() || "stateless"}:${requestId}:${hash({
        name: input.name.trim(),
        cronExpr: input.cronExpr.trim(),
        prompt: input.prompt,
      })}`
    : `mcp:create_schedule:${hash({
        name: input.name.trim(),
        cronExpr: input.cronExpr.trim(),
        prompt: input.prompt,
      })}`;
  return await convex().mutation(convexApi.schedules.create, {
    name: input.name,
    cronExpr: input.cronExpr,
    prompt: input.prompt,
    enabled: true,
    operationKey,
  });
}

export async function durableListSchedules(): Promise<any[]> {
  const schedules = await convex().query(convexApi.schedules.list, {
    limit: 500,
    includeDeleted: true,
    includeDisabled: true,
  });
  if (!Array.isArray(schedules)) return [];
  return schedules.map(legacySchedule);
}

export async function durableCancelSchedule(scheduleId: string): Promise<any> {
  return await convex().mutation(convexApi.schedules.deleteSchedule, { scheduleId });
}

export { durableDispatchTask, durableResolvePause, durableSweep };
