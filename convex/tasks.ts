import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: {},
  returns: v.any(),
  handler: async (ctx) => await ctx.db.query("tasks").first(),
});

// Phase 3 task contracts live in missions.ts to keep the legacy spike API stable.
export { createTask, updateTask, getTaskDispatchContext, admitSpecialist, admitFollowup, resumeSpecialist, finalizeSpecialist, resetSpecialistForRetry, markDone, readySuccessors, reconcileSuccessors, appendTaskEvent } from "./missions";

export const updateStatus = mutation({
  args: { status: v.string() },
  returns: v.id("tasks"),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("tasks").first();
    const updatedAt = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { column: args.status, status: args.status, updatedAt });
      return existing._id;
    }
    return await ctx.db.insert("tasks", {
      title: "Convex realtime foundation",
      name: "Convex realtime spike",
      role: "spike",
      column: args.status,
      status: args.status,
      dependsOn: [],
      createdAt: updatedAt,
      updatedAt,
    });
  },
});
