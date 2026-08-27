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

function hash(value: unknown): string {
  const input = typeof value === "string" ? value : JSON.stringify(value ?? null);
  let result = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    result ^= input.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16);
}

export async function durableBoard(): Promise<any[]> {
  return await durableGetBoard();
}

export async function durableTask(taskId: string): Promise<any | null> {
  const task = await convex().query(convexApi.missions.getTask, { taskId });
  if (!task) return null;
  if (Array.isArray(task.events)) {
    task.events = [...task.events]
      .sort((a: any, b: any) => Number(b.seq ?? 0) - Number(a.seq ?? 0))
      .slice(0, 20);
  }
  return task;
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
  return docs.map((document: any) => ({
    ...document,
    mission: missionById.has(id(document.missionId)) ? { title: missionById.get(id(document.missionId))?.title } : null,
    task: taskById.has(id(document.taskId)) ? { title: taskById.get(id(document.taskId))?.title, role: taskById.get(id(document.taskId))?.role } : null,
  }));
}

export async function durableGetDoc(docId: string): Promise<any | null> {
  const document = await convex().query(convexApi.documents.get, { documentId: docId });
  if (!document) return null;
  const [mission, task] = await Promise.all([
    document.missionId ? convex().query(convexApi.missions.getMission, { missionId: id(document.missionId) }) : null,
    document.taskId ? convex().query(convexApi.missions.getTask, { taskId: id(document.taskId) }) : null,
  ]);
  return {
    ...document,
    mission: mission ? { title: mission.title } : null,
    task: task ? { title: task.title, role: task.role } : null,
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
  return Array.isArray(schedules) ? schedules : [];
}

export async function durableCancelSchedule(scheduleId: string): Promise<any> {
  return await convex().mutation(convexApi.schedules.deleteSchedule, { scheduleId });
}

export { durableDispatchTask, durableResolvePause, durableSweep };
