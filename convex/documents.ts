import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const documentId = v.id("documents");
const missionId = v.id("missions");
const taskId = v.id("tasks");
function cap(value: number | undefined, fallback = 100, maximum = 500): number { return Math.max(1, Math.min(maximum, value ?? fallback)); }
const allowedKinds = new Set(["artifact", "handoff"]);

async function ownership(ctx: any, requestedMission: any, requestedTask: any): Promise<any> {
  const task = requestedTask ? await ctx.db.get(requestedTask) : null;
  if (requestedTask && !task) return { error: { kind: "not_found", entity: "task" } };
  const mission = requestedMission ? await ctx.db.get(requestedMission) : task?.missionId ? await ctx.db.get(task.missionId) : null;
  if (requestedMission && !mission) return { error: { kind: "not_found", entity: "mission" } };
  if (task && mission && String(task.missionId) !== String(mission._id)) return { error: { kind: "conflict", reason: "task_mission_mismatch" } };
  return { mission, task };
}

async function appendTaskEvent(ctx: any, taskId: any, type: string, payload: any, operationKey: string) {
  const duplicate = await ctx.db.query("taskEvents").withIndex("by_task_operationKey", (q: any) => q.eq("taskId", taskId).eq("operationKey", operationKey)).first();
  if (duplicate) return duplicate;
  const task = await ctx.db.get(taskId); if (!task) return null;
  const latest = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", taskId)).order("desc").first();
  const seq = Math.max(task.lastSeq ?? 0, latest?.seq ?? 0) + 1;
  const id = await ctx.db.insert("taskEvents", { taskId, seq, type, payload, operationKey, createdAt: Date.now() });
  await ctx.db.patch(taskId, { lastSeq: seq, updatedAt: Date.now() });
  return await ctx.db.get(id);
}

async function normalizeDocument(ctx: any, args: any, existing?: any): Promise<any> {
  const owner = await ownership(ctx, args.missionId ?? existing?.missionId, args.taskId ?? existing?.taskId);
  if (owner.error) return owner;
  const kind = args.kind ?? existing?.kind ?? "artifact";
  if (owner.task && !allowedKinds.has(kind)) return { error: { kind: "conflict", reason: "invalid_task_document_kind" } };
  if (owner.task && args.authorRole !== undefined && args.authorRole.trim() !== owner.task.role) return { error: { kind: "conflict", reason: "author_role_mismatch" } };
  return { ...owner, kind };
}

export const list = query({
  args: { missionId: v.optional(missionId), taskId: v.optional(taskId), kind: v.optional(v.string()), limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const limit = cap(args.limit);
    let docs: any[];
    if (args.taskId !== undefined) docs = await ctx.db.query("documents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("desc").take(limit);
    else if (args.missionId !== undefined) docs = await ctx.db.query("documents").withIndex("by_mission", (q: any) => q.eq("missionId", args.missionId)).order("desc").take(limit);
    else if (args.kind !== undefined) docs = await ctx.db.query("documents").withIndex("by_kind", (q: any) => q.eq("kind", args.kind)).order("desc").take(limit);
    else docs = await ctx.db.query("documents").withIndex("by_updatedAt").order("desc").take(limit);
    return args.kind === undefined ? docs : docs.filter((doc: any) => doc.kind === args.kind);
  },
});

export const get = query({ args: { documentId }, returns: v.any(), handler: async (ctx, args) => await ctx.db.get(args.documentId) });

const documentInput = { title: v.string(), content: v.string(), authorRole: v.optional(v.string()), kind: v.optional(v.string()), missionId: v.optional(missionId), taskId: v.optional(taskId) };

export const create = mutation({
  args: { operationKey: v.optional(v.string()), ...documentInput }, returns: v.any(),
  handler: async (ctx, args) => {
    if (!args.title.trim() || !args.content.trim()) return { kind: "conflict", reason: "empty_document" };
    if (args.operationKey) {
      const existing = await ctx.db.query("documents").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first();
      if (existing) {
        if ((args.taskId !== undefined && String(existing.taskId) !== String(args.taskId)) || (args.missionId !== undefined && String(existing.missionId) !== String(args.missionId))) return { kind: "conflict", reason: "operation_key_owned_by_other_document" };
        return existing;
      }
    }
    const normalized = await normalizeDocument(ctx, args); if (normalized.error) return normalized.error;
    const now = Date.now();
    const id = await ctx.db.insert("documents", { title: args.title.trim(), content: args.content, authorRole: (normalized.task?.role ?? args.authorRole?.trim()) || "unknown", kind: normalized.kind, ...(normalized.mission ? { missionId: normalized.mission._id } : {}), ...(normalized.task ? { taskId: normalized.task._id, missionId: normalized.mission?._id ?? normalized.task.missionId } : {}), ...(args.operationKey ? { operationKey: args.operationKey } : {}), createdAt: now, updatedAt: now });
    if (normalized.task) await appendTaskEvent(ctx, normalized.task._id, "activity.document_created", { documentId: id, title: args.title.trim(), kind: normalized.kind }, `document:${id}:created`);
    return await ctx.db.get(id);
  },
});

export const update = mutation({
  args: { documentId, title: v.optional(v.string()), content: v.optional(v.string()), authorRole: v.optional(v.string()), kind: v.optional(v.string()), missionId: v.optional(missionId), taskId: v.optional(taskId) }, returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.documentId); if (!existing) return { kind: "not_found", entity: "document" };
    if (args.title !== undefined && !args.title.trim() || args.content !== undefined && !args.content.trim()) return { kind: "conflict", reason: "empty_document" };
    const normalized = await normalizeDocument(ctx, args, existing); if (normalized.error) return normalized.error;
    const patch: any = { updatedAt: Date.now(), kind: normalized.kind };
    if (args.title !== undefined) patch.title = args.title.trim();
    if (args.content !== undefined) patch.content = args.content;
    if (args.authorRole !== undefined) patch.authorRole = args.authorRole.trim();
    if (args.missionId !== undefined) patch.missionId = args.missionId;
    if (args.taskId !== undefined) patch.taskId = args.taskId;
    await ctx.db.patch(args.documentId, patch);
    if (existing.taskId) await appendTaskEvent(ctx, existing.taskId, "activity.document_updated", { documentId: args.documentId, title: patch.title ?? existing.title, kind: normalized.kind }, `document:${args.documentId}:updated:${JSON.stringify({ title: args.title, content: args.content, kind: normalized.kind })}`);
    return await ctx.db.get(args.documentId);
  },
});

export const remove = mutation({ args: { documentId }, returns: v.any(), handler: async (ctx, args) => { if (!(await ctx.db.get(args.documentId))) return { kind: "not_found" }; await ctx.db.delete(args.documentId); return { kind: "deleted" }; } });
export const deleteDocument = remove;

export const save = mutation({
  args: { operationKey: v.string(), ...documentInput }, returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("documents").withIndex("by_operationKey", (q: any) => q.eq("operationKey", args.operationKey)).first();
    const normalized = await normalizeDocument(ctx, args, existing ?? undefined); if (normalized.error) return normalized.error;
    if (existing) {
      await ctx.db.patch(existing._id, { title: args.title.trim(), content: args.content, authorRole: args.authorRole?.trim() || existing.authorRole, kind: normalized.kind, ...(normalized.mission ? { missionId: normalized.mission._id } : {}), ...(normalized.task ? { taskId: normalized.task._id, missionId: normalized.mission?._id ?? normalized.task.missionId } : {}), updatedAt: Date.now() });
      if (existing.taskId) await appendTaskEvent(ctx, existing.taskId, "activity.document_updated", { documentId: existing._id, title: args.title.trim(), kind: normalized.kind }, `document:${existing._id}:save:${args.operationKey}`);
      return await ctx.db.get(existing._id);
    }
    const now = Date.now();
    const id = await ctx.db.insert("documents", { operationKey: args.operationKey, title: args.title.trim(), content: args.content, authorRole: (normalized.task?.role ?? args.authorRole?.trim()) || "unknown", kind: normalized.kind, ...(normalized.mission ? { missionId: normalized.mission._id } : {}), ...(normalized.task ? { taskId: normalized.task._id, missionId: normalized.mission?._id ?? normalized.task.missionId } : {}), createdAt: now, updatedAt: now });
    return await ctx.db.get(id);
  },
});
