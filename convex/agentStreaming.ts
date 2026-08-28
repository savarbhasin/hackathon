/* eslint-disable @typescript-eslint/no-explicit-any */
import { createThread, syncStreams, vStreamArgs } from "@convex-dev/agent";
import { v } from "convex/values";
import { components } from "./_generated/api";
import { mutation, query } from "./_generated/server";

const streamMetadata = {
  threadId: v.string(),
  userId: v.optional(v.string()),
  order: v.number(),
  stepOrder: v.number(),
  agentName: v.optional(v.string()),
  model: v.optional(v.string()),
  provider: v.optional(v.string()),
  providerOptions: v.optional(v.any()),
  format: v.optional(v.union(v.literal("UIMessageChunk"), v.literal("TextStreamPart"))),
};

async function streamOwner(ctx: any, streamId: string) {
  return await ctx.db
    .query("agentStreams")
    .withIndex("by_streamId", (q: any) => q.eq("streamId", streamId))
    .unique();
}

async function currentOwner(ctx: any, streamId: string, expectedAttempt: number, expectedWorkerId: string) {
  const owner = await streamOwner(ctx, streamId);
  if (!owner || owner.attempt !== expectedAttempt || owner.workerId !== expectedWorkerId) return null;
  const run = await ctx.db.get(owner.runId);
  if (!run || run.attempt !== owner.attempt || run.claimedBy !== owner.workerId) return null;
  return { owner, run };
}

/** Lazily gives an application conversation an official Agent component thread. */
export const ensureConversationThread = mutation({
  args: { conversationId: v.id("conversations") },
  returns: v.string(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) throw new Error("Conversation not found");
    if (conversation.agentThreadId) return conversation.agentThreadId;
    const threadId = await createThread(ctx, components.agent, { title: conversation.title });
    await ctx.db.patch(args.conversationId, { agentThreadId: threadId });
    return threadId;
  },
});

/**
 * Public worker bridge for DeltaStreamer. The component's mutation references
 * are internal to Convex, so the external BullMQ worker calls these guarded
 * application mutations while still using the official DeltaStreamer class.
 */
export const create = mutation({
  args: {
    ...streamMetadata,
    expectedAttempt: v.number(),
    expectedWorkerId: v.string(),
  },
  returns: v.string(),
  handler: async (ctx, args) => {
    if (!args.userId) throw new Error("Stream is missing its run owner");
    const runId = ctx.db.normalizeId("agentRuns", args.userId);
    if (!runId) throw new Error("Stream run owner is invalid");
    const run = await ctx.db.get(runId);
    if (!run || run.kind !== "orchestrator" || !run.conversationId || !run.claimedBy
      || args.expectedAttempt !== run.attempt || args.expectedWorkerId !== run.claimedBy) {
      throw new Error("Run is not owned by the requesting orchestrator worker");
    }
    const conversation = await ctx.db.get(run.conversationId);
    if (!conversation || conversation.agentThreadId !== args.threadId) {
      throw new Error("Stream thread does not belong to the run conversation");
    }
    const priorStreams = await ctx.db
      .query("agentStreams")
      .withIndex("by_run_attempt", (q: any) => q.eq("runId", run._id))
      .collect();
    const existing = priorStreams.find((stream: any) => stream.attempt === run.attempt);
    if (existing && existing.state === "streaming") return existing.streamId;
    // A worker can disappear without running its catch path. Supersede any
    // still-live component stream from an older attempt before exposing the
    // replacement, otherwise clients would temporarily render both.
    for (const prior of priorStreams) {
      if (prior.state !== "streaming" || prior.attempt >= run.attempt) continue;
      await ctx.runMutation(components.agent.streams.abort, {
        streamId: prior.streamId as never,
        reason: "superseded by a newer worker attempt",
      });
      await ctx.db.delete(prior._id);
    }

    const streamId = await ctx.runMutation(components.agent.streams.create, {
      threadId: args.threadId as never,
      order: args.order,
      stepOrder: args.stepOrder,
      ...(args.userId ? { userId: args.userId } : {}),
      ...(args.agentName ? { agentName: args.agentName } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.provider ? { provider: args.provider } : {}),
      ...(args.providerOptions ? { providerOptions: args.providerOptions } : {}),
      ...(args.format ? { format: args.format } : {}),
    });
    const now = Date.now();
    await ctx.db.insert("agentStreams", {
      streamId,
      threadId: args.threadId,
      conversationId: run.conversationId,
      runId: run._id,
      attempt: run.attempt,
      workerId: run.claimedBy,
      state: "streaming",
      createdAt: now,
      updatedAt: now,
    });
    return streamId;
  },
});

export const addDelta = mutation({
  args: {
    streamId: v.string(),
    start: v.number(),
    end: v.number(),
    parts: v.array(v.any()),
    fileRefs: v.optional(v.any()),
    expectedAttempt: v.number(),
    expectedWorkerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!await currentOwner(ctx, args.streamId, args.expectedAttempt, args.expectedWorkerId)) return false;
    return await ctx.runMutation(components.agent.streams.addDelta, {
      streamId: args.streamId as never,
      start: args.start,
      end: args.end,
      parts: args.parts,
      ...(args.fileRefs ? { fileRefs: args.fileRefs } : {}),
    });
  },
});

export const finish = mutation({
  args: {
    streamId: v.string(),
    finalDelta: v.optional(v.any()),
    expectedAttempt: v.number(),
    expectedWorkerId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const owner = await streamOwner(ctx, args.streamId);
    // The prior call may have committed both the component finish and sidecar
    // deletion before its response was lost. Treat that retry as success.
    if (!owner) return null;
    const owned = await currentOwner(ctx, args.streamId, args.expectedAttempt, args.expectedWorkerId);
    if (!owned) throw new Error("Stream ownership was lost before finish");
    await ctx.runMutation(components.agent.streams.finish, {
      streamId: args.streamId as never,
      ...(args.finalDelta ? { finalDelta: args.finalDelta } : {}),
    });
    await ctx.db.delete(owned.owner._id);
    return null;
  },
});

export const abort = mutation({
  args: {
    streamId: v.string(),
    reason: v.string(),
    finalDelta: v.optional(v.any()),
    expectedAttempt: v.number(),
    expectedWorkerId: v.string(),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    // A reclaimed worker may still abort the stream it originally created,
    // but it can never append or finish it after ownership changes.
    const owner = await streamOwner(ctx, args.streamId);
    if (!owner || owner.attempt !== args.expectedAttempt || owner.workerId !== args.expectedWorkerId) return false;
    const aborted = await ctx.runMutation(components.agent.streams.abort, {
      streamId: args.streamId as never,
      reason: args.reason.slice(0, 500),
      ...(args.finalDelta ? { finalDelta: args.finalDelta } : {}),
    });
    await ctx.db.delete(owner._id);
    return aborted;
  },
});

/** Official delta synchronization query consumed by useStreamingUIMessages. */
export const list = query({
  args: {
    conversationId: v.id("conversations"),
    threadId: v.string(),
    streamArgs: vStreamArgs,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.agentThreadId !== args.threadId) throw new Error("Conversation stream access denied");
    const streams = await syncStreams(ctx, components.agent, {
      threadId: args.threadId,
      streamArgs: args.streamArgs,
      includeStatuses: ["streaming", "finished"],
    });
    return { streams };
  },
});
