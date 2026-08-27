import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const missionId = v.id("missions");
const taskId = v.id("tasks");
const runId = v.id("agentRuns");

function cap(value: number | undefined, fallback = 100, maximum = 500): number {
  return Math.max(1, Math.min(maximum, value ?? fallback));
}

const ACTIVE_RUNS = new Set(["queued", "enqueued", "connecting", "running", "waiting_for_user", "waiting_for_approval"]);
const TASK_COLUMNS = new Set(["backlog", "working", "blocked", "approval", "settled"]);

// activeRunId wins over the retained specialistRunId. This prevents a stale
// worker from projecting session/terminal state onto a newer admission.
function taskLinkedToRun(task: any, runIdValue: any): boolean {
  return task.activeRunId === runIdValue || (task.activeRunId === undefined && task.specialistRunId === runIdValue);
}

function result(kind: string, extra: Record<string, unknown> = {}) {
  return { kind, ...extra };
}

async function missionTasks(ctx: any, id: any) {
  return await ctx.db.query("tasks").withIndex("by_mission", (q: any) => q.eq("missionId", id)).collect();
}

function validateDeps(tasks: any[], targetId: any, mission: any, deps: any[]): { kind: string; [key: string]: unknown } | null {
  const ids = deps.map(String);
  const missionTasksOnly = tasks.filter((task: any) => String(task.missionId) === String(mission));
  if (new Set(ids).size !== ids.length) return result("conflict", { reason: "duplicate_dependencies" });
  if (ids.some((id) => id === String(targetId))) return result("conflict", { reason: "self_dependency" });
  const byId = new Map(tasks.map((task) => [String(task._id), task]));
  const missing = deps.filter((id) => !byId.has(String(id)));
  if (missing.length) return result("not_found", { reason: "dependency_not_found", dependencyIds: missing });
  const foreign = deps.filter((id) => byId.get(String(id))?.missionId !== mission);
  if (foreign.length) return result("conflict", { reason: "cross_mission_dependency", dependencyIds: foreign });

  const graph = new Map<string, string[]>(missionTasksOnly.map((task: any) => [String(task._id), (task.dependsOn ?? []).map(String)]));
  graph.set(String(targetId), ids);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): string[] | null {
    if (visiting.has(id)) return [id];
    if (visited.has(id)) return null;
    visiting.add(id);
    for (const dep of graph.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return [id, ...cycle];
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }
  for (const id of graph.keys()) {
    const cycle = visit(id);
    if (cycle) return result("conflict", { reason: "dependency_cycle", cycle });
  }
  return null;
}

async function nextPosition(ctx: any, mission: any, requested?: number, excluding?: any): Promise<number> {
  const tasks = await missionTasks(ctx, mission);
  const positions = tasks.filter((t: any) => t._id !== excluding).map((t: any) => Number(t.position));
  if (requested === undefined) return positions.length ? Math.max(...positions) + 1 : 0;
  return Math.max(0, Math.floor(requested));
}

async function insertTaskEvent(ctx: any, id: any, type: string, payload: unknown, operationKey?: string) {
  if (operationKey) {
    const duplicate = await ctx.db.query("taskEvents").withIndex("by_task_operationKey", (q: any) => q.eq("taskId", id).eq("operationKey", operationKey)).first();
    if (duplicate) return { event: duplicate, inserted: false };
  }
  const task = await ctx.db.get(id);
  if (!task) return { event: null, inserted: false };
  const latest = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", id)).order("desc").first();
  const seq = Math.max(task.lastSeq, latest?.seq ?? 0) + 1;
  const event = await ctx.db.insert("taskEvents", { taskId: id, seq, type, payload, ...(operationKey ? { operationKey } : {}), createdAt: Date.now() });
  await ctx.db.patch(id, { lastSeq: seq, updatedAt: Date.now() });
  return { event: await ctx.db.get(event), inserted: true };
}

async function taskDispatchContext(ctx: any, task: any) {
  const mission = await ctx.db.get(task.missionId);
  if (!mission) return null;
  const all = await missionTasks(ctx, task.missionId);
  const byId = new Map<string, any>(all.map((item: any) => [String(item._id), item]));
  const predecessors = [];
  for (const dependencyId of task.dependsOn ?? []) {
    const predecessor = byId.get(String(dependencyId));
    if (!predecessor) continue;
    const docs = predecessor.column === "settled"
      ? (await ctx.db.query("documents").withIndex("by_task", (q: any) => q.eq("taskId", predecessor._id)).order("asc").collect()).filter((doc: any) => doc.kind === "handoff")
      : [];
    predecessors.push({
      id: predecessor._id,
      title: predecessor.title,
      role: predecessor.role,
      column: predecessor.column,
      summary: predecessor.output == null ? null : String(predecessor.output).slice(0, 1200),
      documents: docs.map((doc: any) => ({ id: doc._id, title: doc.title, content: doc.content, kind: doc.kind })),
    });
  }
  const successors = all
    .filter((candidate: any) => candidate._id !== task._id && (candidate.dependsOn ?? []).some((id: any) => String(id) === String(task._id)))
    .sort((a: any, b: any) => Number(a.position) - Number(b.position))
    .map((candidate: any) => ({ id: candidate._id, title: candidate.title, role: candidate.role, column: candidate.column, position: candidate.position }));
  return {
    mission: { id: mission._id, title: mission.title, goal: mission.goal, status: mission.status },
    task: { ...task },
    predecessors,
    successors,
  };
}

async function readySuccessor(ctx: any, candidate: any): Promise<boolean> {
  if (candidate.column !== "backlog") return false;
  const all = await missionTasks(ctx, candidate.missionId);
  const byId = new Map<string, any>(all.map((task: any) => [String(task._id), task]));
  return (candidate.dependsOn ?? []).every((id: any) => byId.get(String(id))?.column === "settled");
}

async function admitSpecialistInternal(ctx: any, args: any, enforceReady = false) {
  const task = await ctx.db.get(args.taskId);
  if (!task) return result("not_found", { entity: "task" });
  const existingRun = await ctx.db.query("agentRuns").withIndex("by_externalId", (q: any) => q.eq("externalId", args.externalId)).first()
    ?? (args.operationKey ? await ctx.db.query("agentRuns").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first() : null);
  if (existingRun) {
    if (existingRun.taskId !== args.taskId) return result("conflict", { reason: "operation_key_owned_by_other_task", run: existingRun });
    if (task.activeRunId !== undefined && task.activeRunId !== existingRun._id) return result("conflict", { reason: "newer_run_already_active", run: existingRun });
    if (task.specialistRunId !== existingRun._id || task.activeRunId !== existingRun._id) await ctx.db.patch(args.taskId, { specialistRunId: existingRun._id, activeRunId: existingRun._id, updatedAt: Date.now() });
    return result("idempotent", { task: await ctx.db.get(args.taskId), run: existingRun });
  }
  if (enforceReady && !(await readySuccessor(ctx, task))) return result("dependency_blocked", { task });
  const linked = task.specialistRunId ? await ctx.db.get(task.specialistRunId) : null;
  if (task.column !== "backlog" || task.sessionId !== undefined || (linked && ACTIVE_RUNS.has(linked.status))) {
    if (linked && linked.externalId === args.externalId) return result("idempotent", { task, run: linked });
    return result("conflict", { reason: "task_not_admissible", task });
  }
  const now = Date.now();
  const created = await ctx.db.insert("agentRuns", {
    externalId: args.externalId,
    operationKey: args.operationKey,
    kind: "specialist",
    status: "queued",
    taskId: args.taskId,
    input: args.kickoffInput,
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(args.taskId, {
    column: "working",
    sessionId: undefined,
    turnId: undefined,
    pendingActions: undefined,
    handoff: undefined,
    output: undefined,
    error: undefined,
    claimedBy: args.owner,
    claimCount: task.claimCount + 1,
    specialistRunId: created,
    activeRunId: created,
    updatedAt: now,
  });
  await insertTaskEvent(ctx, args.taskId, "activity.started", { title: "Agent admitted", runId: created, role: task.role }, `admission:${created}`);
  return result("created", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(created) });
}

export const listMissions = query({
  args: { status: v.optional(v.string()), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => args.status !== undefined
    ? await ctx.db.query("missions").withIndex("by_status", (q: any) => q.eq("status", args.status)).order("desc").take(cap(args.limit))
    : await ctx.db.query("missions").withIndex("by_createdAt").order("desc").take(cap(args.limit)),
});

export const getMission = query({ args: { missionId }, returns: v.any(), handler: async (ctx, args) => await ctx.db.get(args.missionId) });

export const getMissionDetail = query({
  args: { missionId, taskLimit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission) return null;
    const tasks = await ctx.db.query("tasks").withIndex("by_mission", (q: any) => q.eq("missionId", args.missionId)).order("asc").take(cap(args.taskLimit, 500, 1000));
    const documents = await ctx.db.query("documents").withIndex("by_mission", (q: any) => q.eq("missionId", args.missionId)).order("desc").take(200);
    return { ...mission, tasks, documents };
  },
});

export const createMission = mutation({
  args: { title: v.string(), goal: v.string(), status: v.optional(v.string()), operationKey: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    if (args.operationKey) {
      const existing = await ctx.db.query("missions").withIndex("by_externalId", (q: any) => q.eq("externalId", args.operationKey)).first();
      if (existing) return existing;
    }
    const now = Date.now();
    const id = await ctx.db.insert("missions", { title: args.title.trim(), goal: args.goal.trim(), status: args.status ?? "planning", ...(args.operationKey ? { externalId: args.operationKey } : {}), createdAt: now, updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const updateMission = mutation({
  args: { missionId, title: v.optional(v.string()), goal: v.optional(v.string()), status: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.missionId))) return result("not_found");
    const patch: any = { updatedAt: Date.now() };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.goal !== undefined) patch.goal = args.goal.trim();
    if (args.status !== undefined) patch.status = args.status;
    await ctx.db.patch(args.missionId, patch);
    return await ctx.db.get(args.missionId);
  },
});

export const listTasks = query({
  args: { missionId: v.optional(missionId), column: v.optional(v.string()), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const limit = cap(args.limit, 500, 2000);
    if (args.missionId && args.column) return await ctx.db.query("tasks").withIndex("by_mission_column", (q: any) => q.eq("missionId", args.missionId).eq("column", args.column)).order("asc").take(limit);
    if (args.missionId) return await ctx.db.query("tasks").withIndex("by_mission", (q: any) => q.eq("missionId", args.missionId)).order("asc").take(limit);
    if (args.column) return await ctx.db.query("tasks").withIndex("by_column", (q: any) => q.eq("column", args.column)).order("asc").take(limit);
    return await ctx.db.query("tasks").order("asc").take(limit);
  },
});

export const listBoard = query({
  args: { missionId: v.optional(missionId), status: v.optional(v.string()), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const missions = args.missionId ? ((await ctx.db.get(args.missionId)) ? [await ctx.db.get(args.missionId)] : []) : args.status !== undefined
      ? await ctx.db.query("missions").withIndex("by_status", (q: any) => q.eq("status", args.status)).order("desc").take(cap(args.limit))
      : await ctx.db.query("missions").withIndex("by_createdAt").order("desc").take(cap(args.limit));
    const board = [];
    for (const mission of missions) if (mission) board.push({ ...mission, tasks: await ctx.db.query("tasks").withIndex("by_mission", (q: any) => q.eq("missionId", mission._id)).order("asc").take(1000) });
    return board;
  },
});

/**
 * Bounded board subscription. Card projections intentionally exclude agent
 * prompts, outputs, documents, events, and every agentRuns field.
 */
export const boardSnapshot = query({
  args: {
    missionId: v.optional(missionId),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
    taskLimit: v.optional(v.number()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const missionLimit = cap(args.limit, 100, 500);
    const taskLimit = cap(args.taskLimit, 500, 2000);
    let missions: any[];
    if (args.missionId !== undefined) {
      const mission = await ctx.db.get(args.missionId);
      missions = mission ? [mission] : [];
    } else if (args.status !== undefined) {
      missions = await ctx.db.query("missions").withIndex("by_status", (q: any) => q.eq("status", args.status)).order("desc").take(missionLimit);
    } else {
      missions = await ctx.db.query("missions").withIndex("by_createdAt").order("desc").take(missionLimit);
    }
    const board = [];
    for (const mission of missions) {
      const tasks = await ctx.db
        .query("tasks")
        .withIndex("by_mission", (q: any) => q.eq("missionId", mission._id))
        .order("asc")
        .take(taskLimit);
      board.push({
        _id: mission._id,
        _creationTime: mission._creationTime,
        title: mission.title,
        goal: mission.goal,
        status: mission.status,
        createdAt: mission.createdAt,
        updatedAt: mission.updatedAt,
        tasks: tasks.map((task: any) => ({
          _id: task._id,
          _creationTime: task._creationTime,
          ...(task.missionId !== undefined ? { missionId: task.missionId } : {}),
          title: task.title,
          role: task.role,
          column: task.column,
          ...(task.status !== undefined ? { status: task.status } : {}),
          dependsOn: task.dependsOn ?? [],
          ...(task.error !== undefined ? { error: task.error } : {}),
          ...(task.pendingActions !== undefined ? { pendingActions: task.pendingActions } : {}),
          ...(task.position !== undefined ? { position: task.position } : {}),
          updatedAt: task.updatedAt,
        })), 
      });
    }
    return board;
  },
});

/**
 * Core selected-task projection. Activity, documents, and run state are
 * separate queries so each pane has a narrow reactive dependency set.
 */
export const taskCore = query({
  args: { taskId },
  returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const mission = task.missionId ? await ctx.db.get(task.missionId) : null;
    const predecessors = [];
    for (const predecessorId of task.dependsOn ?? []) {
      const predecessor = await ctx.db.get(predecessorId);
      if (!predecessor) continue;
      predecessors.push({
        _id: predecessor._id,
        title: predecessor.title,
        role: predecessor.role,
        column: predecessor.column,
        position: predecessor.position,
      });
    }
    return {
      _id: task._id,
      _creationTime: task._creationTime,
      missionId: task.missionId,
      title: task.title,
      detail: task.detail,
      role: task.role,
      agentPrompt: task.agentPrompt,
      column: task.column,
      dependsOn: task.dependsOn ?? [],
      sessionId: task.sessionId,
      turnId: task.turnId,
      handoff: task.handoff,
      output: task.output,
      error: task.error,
      pendingActions: task.pendingActions,
      position: task.position,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      mission: mission ? { _id: mission._id, title: mission.title, goal: mission.goal, status: mission.status } : null,
      predecessors,
    };
  },
});

export const taskActivity = query({
  args: { taskId, limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db
    .query("taskEvents")
    .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
    .order("asc")
    .take(cap(args.limit, 500, 5000)),
});

/** Selected-task documents include content for the document pane/detail link. */
export const taskDocuments = query({
  args: { taskId, limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const documents = await ctx.db
      .query("documents")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(cap(args.limit, 100, 500));
    return documents.map((document: any) => ({
      _id: document._id,
      _creationTime: document._creationTime,
      taskId: document.taskId,
      missionId: document.missionId,
      title: document.title,
      content: document.content,
      authorRole: document.authorRole,
      kind: document.kind,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
    }));
  },
});

export const getTask = query({
  args: { taskId, eventLimit: v.optional(v.number()), documentLimit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return null;
    const events = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("asc").take(cap(args.eventLimit, 500, 2000));
    const documents = await ctx.db.query("documents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("desc").take(cap(args.documentLimit, 100, 500));
    return { ...task, events, documents };
  },
});

export const getTaskDispatchContext = query({
  args: { taskId }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    return task ? await taskDispatchContext(ctx, task) : null;
  },
});

/** Guarded worker checkpoint for specialist provider ownership. */
export const checkpointSpecialist = mutation({
  args: { taskId, runId, sessionId: v.optional(v.string()), turnId: v.optional(v.string()) }, returns: v.boolean(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    const run = await ctx.db.get(args.runId);
    if (!task || !run || run.kind !== "specialist" || run.taskId !== args.taskId) return false;
    if (!taskLinkedToRun(task, args.runId)) return false;
    if (!ACTIVE_RUNS.has(run.status)) return false;
    if (args.sessionId !== undefined && task.sessionId !== undefined && task.sessionId !== args.sessionId) return false;
    if (args.turnId !== undefined && task.turnId !== undefined && task.turnId !== args.turnId) return false;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.sessionId !== undefined) patch.sessionId = args.sessionId;
    if (args.turnId !== undefined) patch.turnId = args.turnId;
    await ctx.db.patch(args.taskId, patch as any);
    return true;
  },
});

export const createTask = mutation({
  args: { missionId, title: v.string(), detail: v.string(), role: v.string(), agentPrompt: v.optional(v.string()), column: v.optional(v.string()), dependsOn: v.optional(v.array(taskId)), position: v.optional(v.number()), operationKey: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId);
    if (!mission) return result("not_found", { entity: "mission" });
    if (!args.title.trim() || !args.role.trim()) return result("conflict", { reason: "empty_task_field" });
    if (args.column !== undefined && !TASK_COLUMNS.has(args.column)) return result("conflict", { reason: "invalid_column" });
    const tasks = await missionTasks(ctx, args.missionId);
    const allTasks = await ctx.db.query("tasks").collect();
    if (args.operationKey) {
      const existing = await ctx.db.query("tasks").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first();
      if (existing) return String(existing.missionId) === String(args.missionId) ? existing : result("conflict", { reason: "operation_key_owned_by_other_mission" });
    }
    const deps = args.dependsOn ?? [];
    const validation = validateDeps(allTasks, "__new_task__", args.missionId, deps);
    if (validation) return validation;
    const position = await nextPosition(ctx, args.missionId, args.position);
    for (const peer of tasks.filter((task: any) => Number(task.position) >= position)) await ctx.db.patch(peer._id, { position: Number(peer.position) + 1, updatedAt: Date.now() });
    const now = Date.now();
    const id = await ctx.db.insert("tasks", { missionId: args.missionId, title: args.title.trim(), detail: args.detail, role: args.role.trim(), agentPrompt: args.agentPrompt, column: args.column ?? "backlog", dependsOn: deps, lastSeq: 0, position, claimCount: 0, ...(args.operationKey ? { operationKey: args.operationKey, externalId: args.operationKey } : {}), createdAt: now, updatedAt: now });
    return await ctx.db.get(id);
  },
});

export const updateTask = mutation({
  args: { taskId, title: v.optional(v.string()), detail: v.optional(v.string()), role: v.optional(v.string()), agentPrompt: v.optional(v.string()), dependsOn: v.optional(v.array(taskId)), position: v.optional(v.number()), column: v.optional(v.string()), sessionId: v.optional(v.string()), turnId: v.optional(v.string()), handoff: v.optional(v.any()), output: v.optional(v.any()), error: v.optional(v.string()), pendingActions: v.optional(v.any()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return result("not_found", { entity: "task" });
    const tasks = await missionTasks(ctx, task.missionId);
    const allTasks = await ctx.db.query("tasks").collect();
    if (args.dependsOn !== undefined) {
      const validation = validateDeps(allTasks, args.taskId, task.missionId, args.dependsOn);
      if (validation) return validation;
    }
    if (args.column !== undefined && !TASK_COLUMNS.has(args.column)) return result("conflict", { reason: "invalid_column" });
    if (args.position !== undefined) {
      const old = Number(task.position); const next = Math.max(0, Math.floor(args.position));
      if (old !== next) {
        for (const peer of tasks.filter((item: any) => item._id !== task._id && (old < next ? Number(item.position) > old && Number(item.position) <= next : Number(item.position) >= next && Number(item.position) < old))) {
          await ctx.db.patch(peer._id, { position: Number(peer.position) + (old < next ? -1 : 1), updatedAt: Date.now() });
        }
      }
    }
    const patch: any = { updatedAt: Date.now() };
    for (const key of ["title", "detail", "role", "agentPrompt", "dependsOn", "position", "column", "sessionId", "turnId", "handoff", "output", "error", "pendingActions"] as const) if (args[key] !== undefined) patch[key] = key === "title" || key === "role" ? String(args[key]).trim() : args[key];
    await ctx.db.patch(args.taskId, patch);
    return await ctx.db.get(args.taskId);
  },
});

export const appendTaskEvent = mutation({
  args: { taskId, type: v.string(), payload: v.any(), operationKey: v.optional(v.string()), expectedSeq: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return result("not_found", { entity: "task" });
    if (args.operationKey) {
      const duplicate = await ctx.db.query("taskEvents").withIndex("by_task_operationKey", (q: any) => q.eq("taskId", args.taskId).eq("operationKey", args.operationKey)).first();
      if (duplicate) return result("idempotent", { event: duplicate });
    }
    const latest = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("desc").first();
    const current = Math.max(task.lastSeq, latest?.seq ?? 0);
    if (args.expectedSeq !== undefined && current !== args.expectedSeq) return result("conflict", { reason: "sequence_mismatch", expectedSeq: args.expectedSeq, actualSeq: current });
    const event = await insertTaskEvent(ctx, args.taskId, args.type, args.payload, args.operationKey);
    return event.inserted ? result("created", { event: event.event }) : result("idempotent", { event: event.event });
  },
});

export const admitSpecialist = mutation({
  args: { taskId, externalId: v.string(), operationKey: v.optional(v.string()), kickoffInput: v.any(), owner: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => await admitSpecialistInternal(ctx, args),
});

/** Admit a follow-up turn on the task's retained TrueForge session. */
export const admitFollowup = mutation({
  args: { taskId, externalId: v.string(), operationKey: v.optional(v.string()), input: v.any(), owner: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) return result("not_found", { entity: "task" });
    const existing = await ctx.db.query("agentRuns").withIndex("by_externalId", (q: any) => q.eq("externalId", args.externalId)).first()
      ?? (args.operationKey ? await ctx.db.query("agentRuns").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first() : null);
    if (existing) {
      if (existing.taskId !== args.taskId) return result("conflict", { reason: "operation_key_owned_by_other_task" });
      return result("idempotent", { task, run: existing });
    }
    const previous = task.specialistRunId ? await ctx.db.get(task.specialistRunId) : null;
    if (task.column !== "settled" || task.activeRunId !== undefined || !previous || previous.kind !== "specialist" || previous.sessionId === undefined) {
      return result("invalid_state", { reason: "followup_requires_settled_task_session" });
    }
    const now = Date.now();
    const created = await ctx.db.insert("agentRuns", {
      externalId: args.externalId,
      operationKey: args.operationKey,
      kind: "specialist",
      status: "queued",
      taskId: args.taskId,
      input: args.input,
      sessionId: previous.sessionId,
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(args.taskId, {
      column: "working",
      sessionId: previous.sessionId,
      turnId: undefined,
      pendingActions: undefined,
      error: undefined,
      output: undefined,
      claimedBy: args.owner,
      specialistRunId: created,
      activeRunId: created,
      updatedAt: now,
    });
    await insertTaskEvent(ctx, args.taskId, "activity.started", { title: "Follow-up started", runId: created }, `admission:${created}`);
    return result("created", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(created) });
  },
});

export const resumeSpecialist = mutation({
  args: { taskId, runId, selector: v.string(), decisionType: v.union(v.literal("approve"), v.literal("answer")), resumeInput: v.any(), operationKey: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId); const run = await ctx.db.get(args.runId);
    if (!task || !run) return result("not_found");
    if (!taskLinkedToRun(task, args.runId) || run.taskId !== args.taskId) return result("conflict", { reason: "run_not_linked" });
    if (run.status !== "waiting_for_user" && run.status !== "waiting_for_approval") return result("invalid_state", { reason: "run_not_waiting" });
    const actions = Array.isArray(run.pendingActions) ? run.pendingActions : [];
    const matches = run.pendingActionSelector === args.selector || actions.some((action: any) => action?.selector === args.selector || action?.id === args.selector);
    if (!matches) return result("selector_mismatch");
    const expected = run.status === "waiting_for_approval" ? "approve" : "answer";
    if (args.decisionType !== expected) return result("conflict", { reason: "decision_type_mismatch", expected });
    const op = args.operationKey ?? `resume:${args.runId}:${args.selector}:${args.decisionType}`;
    const event = await insertTaskEvent(ctx, args.taskId, args.decisionType === "approve" ? "activity.approval_resolved" : "activity.response_sent", { selector: args.selector, decisionType: args.decisionType }, op);
    await ctx.db.patch(args.runId, { status: "queued", pendingResume: args.resumeInput, claimedBy: undefined, updatedAt: Date.now() });
    await ctx.db.patch(args.taskId, { column: "working", error: undefined, updatedAt: Date.now() });
    return result(event.inserted ? "created" : "idempotent", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(args.runId), event: event.event });
  },
});

export const finalizeSpecialist = mutation({
  args: { taskId, runId, status: v.union(v.literal("completed"), v.literal("waiting_for_approval"), v.literal("waiting_for_user"), v.literal("failed"), v.literal("cancelled")), sessionId: v.optional(v.string()), turnId: v.optional(v.string()), output: v.optional(v.any()), pendingActions: v.optional(v.any()), pendingActionSelector: v.optional(v.string()), errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()), operationKey: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId); const run = await ctx.db.get(args.runId);
    if (!task || !run) return result("not_found");
    if (!taskLinkedToRun(task, args.runId) || run.taskId !== args.taskId) return result("conflict", { reason: "run_not_linked" });
    if (args.sessionId !== undefined && ((task.sessionId !== undefined && task.sessionId !== args.sessionId) || (run.sessionId !== undefined && run.sessionId !== args.sessionId))) return result("conflict", { reason: "session_ownership" });
    if (args.turnId !== undefined && ((task.turnId !== undefined && task.turnId !== args.turnId) || (run.turnId !== undefined && run.turnId !== args.turnId))) return result("conflict", { reason: "turn_ownership" });
    const op = args.operationKey ?? `finalize:${args.runId}:${args.status}`;
    const now = Date.now();
    if (args.status === "completed") {
      const summary = task.output != null && String(task.output).trim() ? task.output : args.output;
      const event = await insertTaskEvent(ctx, args.taskId, "activity.completed", { summary: summary ?? null, runId: args.runId }, op);
      await ctx.db.patch(args.runId, { status: "completed", output: summary, finishedAt: now, updatedAt: now, claimedBy: undefined });
      await ctx.db.patch(args.taskId, { column: "settled", output: summary, sessionId: undefined, turnId: undefined, pendingActions: undefined, error: undefined, activeRunId: undefined, updatedAt: now });
      return result(event.inserted ? "created" : "idempotent", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(args.runId) });
    }
    if (args.status === "cancelled") {
      await ctx.db.patch(args.runId, { status: "cancelled", finishedAt: now, updatedAt: now, claimedBy: undefined });
      await ctx.db.patch(args.taskId, { column: "backlog", sessionId: undefined, turnId: undefined, pendingActions: undefined, handoff: undefined, output: undefined, error: args.errorMessage ?? "cancelled", specialistRunId: undefined, activeRunId: undefined, updatedAt: now });
      const event = await insertTaskEvent(ctx, args.taskId, "activity.cancelled", { reason: args.errorMessage ?? null, runId: args.runId }, op);
      return result(event.inserted ? "created" : "idempotent", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(args.runId) });
    }
    if (args.status === "failed") {
      await ctx.db.patch(args.runId, { status: "failed", errorCode: args.errorCode, errorMessage: args.errorMessage, ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}), ...(args.turnId !== undefined ? { turnId: args.turnId } : {}), finishedAt: now, updatedAt: now, claimedBy: undefined });
      await ctx.db.patch(args.taskId, { column: "blocked", sessionId: args.sessionId ?? run.sessionId, turnId: args.turnId ?? run.turnId, pendingActions: undefined, activeRunId: undefined, error: args.errorMessage ?? args.errorCode ?? "run_failed", updatedAt: now });
      const event = await insertTaskEvent(ctx, args.taskId, "activity.failed", { runId: args.runId, errorCode: args.errorCode, message: args.errorMessage }, op);
      return result(event.inserted ? "created" : "idempotent", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(args.runId), event: event.event });
    }
    const waiting = args.status === "waiting_for_approval";
    await ctx.db.patch(args.runId, { status: waiting ? "waiting_for_approval" : "waiting_for_user", pendingActions: args.pendingActions, pendingActionSelector: args.pendingActionSelector, ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}), ...(args.turnId !== undefined ? { turnId: args.turnId } : {}), updatedAt: now, claimedBy: undefined });
    await ctx.db.patch(args.taskId, { column: waiting ? "approval" : "blocked", sessionId: args.sessionId ?? run.sessionId, turnId: args.turnId ?? run.turnId, activeRunId: args.runId, pendingActions: args.pendingActions, error: args.errorMessage, updatedAt: now });
    const event = await insertTaskEvent(ctx, args.taskId, waiting ? "activity.waiting_approval" : "activity.waiting_response", { runId: args.runId, pendingActions: args.pendingActions }, op);
    return result(event.inserted ? "created" : "idempotent", { task: await ctx.db.get(args.taskId), run: await ctx.db.get(args.runId) });
  },
});

export const markDone = mutation({
  args: { taskId, summary: v.string(), runId: v.optional(runId), operationKey: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId); if (!task) return result("not_found", { entity: "task" });
    const linkedId = args.runId ?? task.activeRunId ?? task.specialistRunId;
    if (!linkedId) return result("invalid_state", { reason: "no_specialist_run" });
    if (!taskLinkedToRun(task, linkedId)) return result("conflict", { reason: "run_not_active" });
    const run = await ctx.db.get(linkedId);
    if (!run || run.taskId !== args.taskId || run.kind !== "specialist") return result("conflict", { reason: "run_not_linked" });
    if (!ACTIVE_RUNS.has(run.status) && run.status !== "completed") return result("invalid_state", { reason: "run_not_active" });
    const summary = args.summary.trim(); if (!summary) return result("conflict", { reason: "empty_summary" });
    if (task.output != null) {
      if (String(task.output) !== summary) return result("conflict", { reason: "conflicting_summary" });
      return result("idempotent", { task, run });
    }
    const op = args.operationKey ?? `mark_done:${linkedId}`;
    const event = await insertTaskEvent(ctx, args.taskId, "specialist.mark_done", { summary, runId: linkedId }, op);
    await ctx.db.patch(args.taskId, { output: summary, updatedAt: Date.now() });
    return result(event.inserted ? "created" : "idempotent", { task: await ctx.db.get(args.taskId), run, event: event.event });
  },
});

export const readySuccessors = query({
  args: { taskId }, returns: v.any(),
  handler: async (ctx, args) => {
    const completed = await ctx.db.get(args.taskId); if (!completed) return result("not_found");
    if (completed.column !== "settled") return result("dependency_blocked", { reason: "predecessor_not_settled" });
    const all = await missionTasks(ctx, completed.missionId);
    const candidates = all.filter((task: any) => task._id !== completed._id && task.dependsOn.some((id: any) => String(id) === String(completed._id))).sort((a: any, b: any) => Number(a.position) - Number(b.position));
    const ready = []; for (const candidate of candidates) if (await readySuccessor(ctx, candidate)) ready.push(await taskDispatchContext(ctx, candidate));
    return ready;
  },
});

export const reconcileSuccessors = mutation({
  args: { taskId, admissions: v.array(v.object({ taskId, externalId: v.string(), operationKey: v.optional(v.string()), kickoffInput: v.any(), owner: v.optional(v.string()) })) }, returns: v.any(),
  handler: async (ctx, args) => {
    const completed = await ctx.db.get(args.taskId); if (!completed) return result("not_found");
    if (completed.column !== "settled") return result("dependency_blocked", { reason: "predecessor_not_settled" });
    const all = await missionTasks(ctx, completed.missionId); const direct = new Set(all.filter((task: any) => (task.dependsOn ?? []).some((id: any) => String(id) === String(completed._id))).map((task: any) => String(task._id)));
    const results = []; for (const admission of args.admissions) {
      if (!direct.has(String(admission.taskId))) { results.push({ taskId: admission.taskId, ...result("conflict", { reason: "not_successor" }) }); continue; }
      results.push({ taskId: admission.taskId, ...(await admitSpecialistInternal(ctx, admission, true)) });
    }
    return { kind: "ok", results };
  },
});

/**
 * Prepare a failed/cancelled specialist task for a fresh logical run.
 * This is deliberately only a Convex state transition: queue delivery is
 * performed by the caller after this mutation commits.
 */
export const resetSpecialistForRetry = mutation({
  args: {
    taskId,
    expectedSpecialistRunId: runId,
    expectedSessionId: v.optional(v.string()),
    expectedTurnId: v.optional(v.string()),
    operationKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const operationKey = args.operationKey ?? `retry-reset:${args.taskId}:${args.expectedSpecialistRunId}`;
    const prior = await ctx.db.query("taskEvents").withIndex("by_task_operationKey", (q: any) => q.eq("taskId", args.taskId).eq("operationKey", operationKey)).first();
    if (prior) return result("ok", { idempotent: true, event: prior, task: await ctx.db.get(args.taskId) });

    const task = await ctx.db.get(args.taskId);
    const run = await ctx.db.get(args.expectedSpecialistRunId);
    if (!task || !run) return result("not_found", { entity: !task ? "task" : "agent_run" });
    if (run.taskId !== args.taskId || !taskLinkedToRun(task, args.expectedSpecialistRunId)) {
      return result("conflict", { reason: "run_not_linked" });
    }
    if (run.kind !== "specialist") return result("conflict", { reason: "not_specialist_run" });
    if (args.expectedSessionId !== undefined && ((task.sessionId !== undefined && task.sessionId !== args.expectedSessionId) || (run.sessionId !== undefined && run.sessionId !== args.expectedSessionId))) return result("conflict", { reason: "session_ownership" });
    if (args.expectedTurnId !== undefined && ((task.turnId !== undefined && task.turnId !== args.expectedTurnId) || (run.turnId !== undefined && run.turnId !== args.expectedTurnId))) return result("conflict", { reason: "turn_ownership" });
    if (run.status !== "failed" && run.status !== "cancelled") return result("invalid_state", { reason: "run_not_retryable", status: run.status });
    if (task.column !== "blocked" && task.column !== "backlog") return result("invalid_state", { reason: "task_not_retryable", column: task.column });
    if (task.column === "backlog" && task.specialistRunId === undefined && task.activeRunId === undefined) return result("invalid_state", { reason: "retry_reset_not_needed" });

    const now = Date.now();
    // Undefined fields are explicit deletes in Convex patches. Output and
    // Handoff and output remain available as retry context.
    await ctx.db.patch(args.taskId, {
      column: "backlog",
      sessionId: undefined,
      turnId: undefined,
      specialistRunId: undefined,
      activeRunId: undefined,
      pendingActions: undefined,
      claimedBy: undefined,
      error: undefined,
      updatedAt: now,
    });
    const event = await insertTaskEvent(ctx, args.taskId, "activity.retry_reset", {
      runId: args.expectedSpecialistRunId,
      retainedOutput: task.output !== undefined,
      retainedHandoff: task.handoff !== undefined,
    }, operationKey);
    return result("ok", { idempotent: false, task: await ctx.db.get(args.taskId), run, event: event.event });
  },
});

export const deleteMission = mutation({
  args: { missionId }, returns: v.boolean(),
  handler: async (ctx, args) => {
    const mission = await ctx.db.get(args.missionId); if (!mission) return false;
    const tasks = await missionTasks(ctx, args.missionId); for (const task of tasks) {
      const events = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", task._id)).collect(); for (const event of events) await ctx.db.delete(event._id);
      const docs = await ctx.db.query("documents").withIndex("by_task", (q: any) => q.eq("taskId", task._id)).collect(); for (const doc of docs) await ctx.db.patch(doc._id, { taskId: undefined });
      await ctx.db.delete(task._id);
    }
    const docs = await ctx.db.query("documents").withIndex("by_mission", (q: any) => q.eq("missionId", args.missionId)).collect(); for (const doc of docs) await ctx.db.delete(doc._id);
    await ctx.db.delete(args.missionId); return true;
  },
});

export const deleteTask = mutation({
  args: { taskId }, returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.taskId))) return false;
    const events = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).collect(); for (const event of events) await ctx.db.delete(event._id);
    const docs = await ctx.db.query("documents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).collect(); for (const doc of docs) await ctx.db.patch(doc._id, { taskId: undefined });
    await ctx.db.delete(args.taskId); return true;
  },
});

export const claimTask = mutation({
  args: { taskId, owner: v.string(), expectedColumn: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId); if (!task) return result("not_found");
    if (task.column !== (args.expectedColumn ?? "backlog") || task.sessionId !== undefined || task.specialistRunId !== undefined || task.activeRunId !== undefined) return result("conflict", { reason: "task_not_admissible" });
    await ctx.db.patch(args.taskId, { column: "working", claimedBy: args.owner, claimCount: task.claimCount + 1, updatedAt: Date.now() }); return result("created", { task: await ctx.db.get(args.taskId) });
  },
});

export const transitionTask = mutation({
  args: { taskId, expectedColumn: v.optional(v.string()), expectedSessionId: v.optional(v.string()), expectedTurnId: v.optional(v.string()), nextColumn: v.string(), owner: v.optional(v.string()), patch: v.optional(v.any()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId); if (!task) return result("not_found");
    if ((args.expectedColumn !== undefined && task.column !== args.expectedColumn) || (args.expectedSessionId !== undefined && task.sessionId !== args.expectedSessionId) || (args.expectedTurnId !== undefined && task.turnId !== args.expectedTurnId) || (args.owner !== undefined && task.claimedBy !== args.owner)) return result("conflict", { reason: "guard_mismatch" });
    await ctx.db.patch(args.taskId, { ...(args.patch ?? {}), column: args.nextColumn, updatedAt: Date.now() }); return await ctx.db.get(args.taskId);
  },
});

export const releaseTaskClaim = mutation({
  args: { taskId, owner: v.string(), nextColumn: v.optional(v.string()) }, returns: v.any(),
  handler: async (ctx, args) => { const task = await ctx.db.get(args.taskId); if (!task) return result("not_found"); if (task.claimedBy !== args.owner) return result("conflict"); await ctx.db.patch(args.taskId, { claimedBy: undefined, column: args.nextColumn ?? "backlog", updatedAt: Date.now() }); return result("idempotent", { task: await ctx.db.get(args.taskId) }); },
});

export const listTaskEvents = query({ args: { taskId, limit: v.optional(v.number()) }, returns: v.any(), handler: async (ctx, args) => await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("asc").take(cap(args.limit, 500, 5000)) });
