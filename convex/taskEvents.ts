import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const taskId = v.id("tasks");
export const list = query({
  args: { taskId, limit: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("asc").take(Math.max(1, Math.min(5000, args.limit ?? 500))),
});

/** Compatibility entry point; missions.appendTaskEvent owns the canonical allocator. */
export const append = mutation({
  args: { taskId, type: v.string(), payload: v.any(), operationKey: v.optional(v.string()), expectedSeq: v.optional(v.number()) }, returns: v.any(),
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId); if (!task) return { kind: "not_found" };
    if (args.operationKey) {
      const existing = await ctx.db.query("taskEvents").withIndex("by_task_operationKey", (q: any) => q.eq("taskId", args.taskId).eq("operationKey", args.operationKey)).first();
      if (existing) return { kind: "idempotent", event: existing };
    }
    const latest = await ctx.db.query("taskEvents").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("desc").first();
    const current = Math.max(task.lastSeq ?? 0, latest?.seq ?? 0);
    if (args.expectedSeq !== undefined && args.expectedSeq !== current) return { kind: "conflict", reason: "sequence_mismatch", actualSeq: current };
    const seq = current + 1;
    const id = await ctx.db.insert("taskEvents", { taskId: args.taskId, seq, type: args.type, payload: args.payload, ...(args.operationKey ? { operationKey: args.operationKey } : {}), createdAt: Date.now() });
    await ctx.db.patch(args.taskId, { lastSeq: seq, updatedAt: Date.now() });
    return { kind: "created", event: await ctx.db.get(id) };
  },
});

export const appendTaskEvent = append;
export const listTaskEvents = list;
