import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const conversationId = v.id("conversations");
const messageId = v.id("chatMessages");

function cap(value: number | undefined, fallback = 100, maximum = 500): number {
  return Math.max(1, Math.min(maximum, value ?? fallback));
}

const activeRunStatuses = new Set([
  "queued",
  "enqueued",
  "connecting",
  "running",
  "waiting_for_user",
  "waiting_for_approval",
]);

// Only these message transitions represent durable conversation activity. In
// particular, a streaming assistant update must not reorder or invalidate the
// global sidebar on every token.
const summaryMessageStatuses = new Set([
  "completed",
  "waiting_for_user",
  "waiting_for_approval",
  "failed",
  "cancelled",
]);

function isSummaryMessage(role: string, status?: string): boolean {
  return role === "user" || (role === "assistant" && !!status && summaryMessageStatuses.has(status));
}

function isSummaryTransition(message: any, nextStatus?: string): boolean {
  if (message.role === "user") return true;
  return message.role === "assistant"
    && nextStatus !== undefined
    && summaryMessageStatuses.has(nextStatus)
    && nextStatus !== message.status;
}

async function bumpMessageCount(ctx: any, id: any): Promise<void> {
  const conversation = await ctx.db.get(id);
  if (!conversation) return;
  await ctx.db.patch(id, { messageCount: conversation.messageCount + 1 });
}

async function touchConversationSummary(ctx: any, id: any, now: number, increment = false): Promise<void> {
  const conversation = await ctx.db.get(id);
  if (!conversation) return;
  await ctx.db.patch(id, {
    summaryUpdatedAt: now,
    messageCount: conversation.messageCount + (increment ? 1 : 0),
    updatedAt: now,
  });
}

function fallbackTitle(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return "New conversation";
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 69)}...`;
}

function selectorsIn(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(selectorsIn);
  const record = value as Record<string, unknown>;
  const selectors: string[] = [];
  for (const key of ["selector", "id", "toolCallId", "sourceEventId"]) {
    if (typeof record[key] === "string" && record[key]) selectors.push(record[key] as string);
  }
  return selectors.concat(...Object.values(record).map(selectorsIn));
}

async function conversationRuns(ctx: any, id: any): Promise<any[]> {
  return await ctx.db
    .query("agentRuns")
    .withIndex("by_conversation", (q: any) => q.eq("conversationId", id))
    .order("desc")
    .collect();
}

export const list = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) =>
    await ctx.db.query("conversations").withIndex("by_updated").order("desc").take(cap(args.limit)),
});

/**
 * One bounded subscription for the conversation rail. It deliberately reads
 * no message content or runEvents and returns only the fields needed to draw
 * titles, activity, counts, and run indicators.
 */
export const listSummaries = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversations = await ctx.db
      .query("conversations")
      .withIndex("by_updated")
      .order("desc")
      .take(cap(args.limit, 100, 500));
    const summaries = [];
    for (const conversation of conversations) {
      const runs = await ctx.db
        .query("agentRuns")
        .withIndex("by_conversation", (q: any) => q.eq("conversationId", conversation._id))
        .order("desc")
        .take(100);
      const orchestratorRuns = runs.filter((run: any) => run.kind === "orchestrator");
      const latest = orchestratorRuns[0];
      const active = orchestratorRuns.find((run: any) => activeRunStatuses.has(run.status));
      summaries.push({
        _id: conversation._id,
        _creationTime: conversation._creationTime,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        summaryUpdatedAt: conversation.summaryUpdatedAt,
        messageCount: conversation.messageCount,
        latestRun: latest ? { _id: latest._id, status: latest.status } : null,
        activeRun: active ? { _id: active._id, status: active.status } : null,
      });
    }
    return summaries.sort((a: any, b: any) => Number(b.summaryUpdatedAt) - Number(a.summaryUpdatedAt));
  },
});

export const get = query({
  args: { conversationId },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.get(args.conversationId),
});

/** Core selected-conversation record; message history is a separate stream. */
export const conversationState = query({
  args: { conversationId },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;
    return {
      _id: conversation._id,
      _creationTime: conversation._creationTime,
      title: conversation.title,
      sessionId: conversation.sessionId,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      summaryUpdatedAt: conversation.summaryUpdatedAt,
      messageCount: conversation.messageCount,
    };
  },
});

export const getDetail = query({
  args: { conversationId, messageLimit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return null;
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("asc")
      .take(cap(args.messageLimit, 500, 1000));
    return { ...conversation, messages };
  },
});

export const getBySession = query({
  args: { sessionId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) =>
    await ctx.db.query("conversations").withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId)).first(),
});

export const create = mutation({
  args: {
    title: v.string(),
    sessionId: v.optional(v.string()),
    operationKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (args.operationKey) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_operationKey", (q) => q.eq("operationKey", args.operationKey))
        .first();
      if (existing) return existing;
    }
    if (args.sessionId) {
      const existing = await ctx.db
        .query("conversations")
        .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
        .first();
      if (existing) return existing;
    }
    const now = Date.now();
    const id = await ctx.db.insert("conversations", {
      title: args.title,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      ...(args.operationKey ? { operationKey: args.operationKey } : {}),
      summaryUpdatedAt: now,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

/**
 * Atomically admits one logical user start and its orchestrator delivery.
 * Convex owns this transaction; the web process only enqueues the returned run.
 */
export const admitStart = mutation({
  args: {
    conversationId: v.optional(conversationId),
    conversationOperationKey: v.optional(v.string()),
    operationKey: v.optional(v.string()),
    messageOperationKey: v.optional(v.string()),
    userMessageOperationKey: v.optional(v.string()),
    externalId: v.string(),
    message: v.string(),
    title: v.optional(v.string()),
    input: v.any(),
    sessionId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const existingRun = await ctx.db
      .query("agentRuns")
      .withIndex("by_externalId", (q: any) => q.eq("externalId", args.externalId))
      .first();
    if (existingRun) {
      const conversation = existingRun.conversationId ? await ctx.db.get(existingRun.conversationId) : null;
      const message = await ctx.db
        .query("chatMessages")
        .withIndex("by_run", (q: any) => q.eq("runId", existingRun._id))
        .order("asc")
        .first();
      return { kind: "already_accepted", idempotent: true, conversation, message, run: existingRun };
    }

    let conversation = args.conversationId ? await ctx.db.get(args.conversationId) : null;
    if (args.conversationId && !conversation) {
      return { kind: "missing", conversationId: args.conversationId, reason: "conversation_not_found" };
    }
    const conversationKey = args.conversationOperationKey ?? args.operationKey;
    if (!conversation && conversationKey) {
      conversation = await ctx.db
        .query("conversations")
        .withIndex("by_operationKey", (q: any) => q.eq("operationKey", conversationKey))
        .first();
    }

    const now = Date.now();
    if (!conversation) {
      const conversationId = await ctx.db.insert("conversations", {
        ...(conversationKey ? { operationKey: conversationKey } : {}),
        title: args.title?.trim() || fallbackTitle(args.message),
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        summaryUpdatedAt: now,
        messageCount: 0,
        createdAt: now,
        updatedAt: now,
      });
      conversation = await ctx.db.get(conversationId);
    }
    if (!conversation) return { kind: "invalid_state", reason: "conversation_insert_failed" };

    if (args.sessionId && !conversation.sessionId) {
      await ctx.db.patch(conversation._id, { sessionId: args.sessionId });
      conversation = await ctx.db.get(conversation._id);
    }
    if (!conversation) return { kind: "invalid_state", reason: "conversation_update_failed" };
    const conversationId = conversation._id;
    const runs = await conversationRuns(ctx, conversationId);
    const busyRun = runs.find((run: any) => run.kind === "orchestrator" && activeRunStatuses.has(run.status));
    if (busyRun) {
      return {
        kind: "busy",
        conversationId,
        runId: busyRun._id,
        status: busyRun.status,
      };
    }

    const runId = await ctx.db.insert("agentRuns", {
      externalId: args.externalId,
      kind: "orchestrator",
      status: "queued",
      conversationId,
      input: args.input,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    const messageOperationKey = args.messageOperationKey ?? args.userMessageOperationKey ?? `start:${args.externalId}`;
    const existingMessage = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation_operationKey", (q: any) => q.eq("conversationId", conversationId).eq("operationKey", messageOperationKey))
      .first();
    let message;
    let insertedMessage = false;
    if (existingMessage) {
      await ctx.db.patch(existingMessage._id, { runId, updatedAt: now });
      message = await ctx.db.get(existingMessage._id);
    } else {
      const messageId = await ctx.db.insert("chatMessages", {
        conversationId,
        operationKey: messageOperationKey,
        role: "user",
        content: args.message,
        tools: [],
        status: "queued",
        runId,
        createdAt: now,
        updatedAt: now,
      });
      insertedMessage = true;
      message = await ctx.db.get(messageId);
    }
    // User admission is a sidebar-visible activity. Do not use this path for
    // assistant token writes; those are handled by upsertMessage below.
    await touchConversationSummary(ctx, conversationId, now, insertedMessage);
    conversation = await ctx.db.get(conversationId);
    const run = await ctx.db.get(runId);
    return { kind: "accepted", conversation, message, run };
  },
});

/**
 * Atomically consumes one pending selector for the sole waiting orchestrator
 * run in a conversation. Pending actions remain until the worker checkpoints
 * the replacement provider turn.
 */
export const admitResume = mutation({
  args: {
    conversationId,
    operationKey: v.optional(v.string()),
    messageOperationKey: v.optional(v.string()),
    userResponseOperationKey: v.optional(v.string()),
    selector: v.string(),
    resumeInput: v.any(),
    content: v.optional(v.string()),
    answer: v.optional(v.string()),
    response: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return { kind: "missing", conversationId: args.conversationId, reason: "conversation_not_found" };

    const responseOperationKey = args.messageOperationKey ?? args.userResponseOperationKey ?? args.operationKey ?? `resume:${args.conversationId}:${args.selector}`;
    const priorMessage = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation_operationKey", (q: any) => q.eq("conversationId", args.conversationId).eq("operationKey", responseOperationKey))
      .first();
    if (priorMessage?.runId) {
      const priorRun = await ctx.db.get(priorMessage.runId);
      if (priorRun) return { kind: "already_accepted", idempotent: true, conversation, message: priorMessage, run: priorRun };
      return { kind: "invalid_state", conversationId: args.conversationId, reason: "response_run_not_found" };
    }
    if (priorMessage) return { kind: "invalid_state", conversationId: args.conversationId, reason: "operation_key_reused" };

    const waiting = (await conversationRuns(ctx, args.conversationId)).filter(
      (run: any) => run.kind === "orchestrator" && (run.status === "waiting_for_user" || run.status === "waiting_for_approval"),
    );
    if (waiting.length === 0) return { kind: "missing", conversationId: args.conversationId, reason: "no_waiting_orchestrator_run" };
    if (waiting.length !== 1) return { kind: "invalid_state", conversationId: args.conversationId, reason: "multiple_waiting_orchestrator_runs" };

    const run = waiting[0];
    const selectors = [...new Set([
      ...(typeof run.pendingActionSelector === "string" ? [run.pendingActionSelector] : []),
      ...selectorsIn(run.pendingActions),
    ])];
    if (!selectors.includes(args.selector)) {
      return { kind: "selector_mismatch", conversationId: args.conversationId, runId: run._id, selector: args.selector };
    }

    const now = Date.now();
    const messageId = await ctx.db.insert("chatMessages", {
      conversationId: args.conversationId,
      operationKey: responseOperationKey,
      role: "user",
      content: args.content ?? args.answer ?? args.response ?? "Responded to paused action",
      tools: [],
      status: "queued",
      runId: run._id,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(run._id, {
      status: "queued",
      pendingResume: args.resumeInput,
      claimedBy: undefined,
      updatedAt: now,
    });
    await touchConversationSummary(ctx, args.conversationId, now, true);
    const message = await ctx.db.get(messageId);
    const updatedRun = await ctx.db.get(run._id);
    return { kind: "accepted", conversation: await ctx.db.get(args.conversationId), message, run: updatedRun };
  },
});

export const update = mutation({
  args: {
    conversationId,
    title: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.conversationId);
    if (!existing) return null;
    const now = Date.now();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (args.title !== undefined) {
      patch.title = args.title;
      patch.summaryUpdatedAt = now;
    }
    if (args.sessionId !== undefined) patch.sessionId = args.sessionId;
    await ctx.db.patch(args.conversationId, patch as any);
    return await ctx.db.get(args.conversationId);
  },
});

export const touch = mutation({
  args: { conversationId },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.conversationId))) return false;
    await touchConversationSummary(ctx, args.conversationId, Date.now());
    return true;
  },
});

/**
 * Worker-only session checkpoint. A replacement session may overwrite the
 * expected prior value, but a stale worker cannot clobber a newer session.
 */
export const checkpointSession = mutation({
  args: { conversationId, sessionId: v.string(), expectedSessionId: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation) return false;
    if (args.expectedSessionId !== undefined && conversation.sessionId !== args.expectedSessionId) return false;
    if (conversation.sessionId !== undefined && args.expectedSessionId === undefined && conversation.sessionId !== args.sessionId) return false;
    // Session heartbeats are not sidebar activity. Avoid writing the
    // conversation row when the checkpoint is unchanged so reactive summary
    // queries stay quiet during a provider stream.
    if (conversation.sessionId !== args.sessionId) {
      await ctx.db.patch(args.conversationId, { sessionId: args.sessionId, updatedAt: Date.now() });
    }
    return true;
  },
});

export const remove = mutation({
  args: { conversationId },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.conversationId))) return false;
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .collect();
    for (const message of messages) await ctx.db.delete(message._id);
    await ctx.db.delete(args.conversationId);
    return true;
  },
});

export const listMessages = query({
  args: { conversationId, limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) =>
    await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation", (q) => q.eq("conversationId", args.conversationId))
      .order("asc")
      .take(cap(args.limit, 500, 2000)),
});

const messageFields = {
  role: v.string(),
  content: v.string(),
  tools: v.optional(v.any()),
  status: v.optional(v.string()),
  pauseActions: v.optional(v.any()),
  runId: v.optional(v.id("agentRuns")),
};

export const appendMessage = mutation({
  args: { conversationId, operationKey: v.optional(v.string()), ...messageFields },
  returns: v.any(),
  handler: async (ctx, args) => {
    if (!(await ctx.db.get(args.conversationId))) return null;
    if (args.operationKey) {
      const existing = await ctx.db
        .query("chatMessages")
        .withIndex("by_conversation_operationKey", (q) => q.eq("conversationId", args.conversationId).eq("operationKey", args.operationKey))
        .first();
      if (existing) return existing;
    }
    const now = Date.now();
    const id = await ctx.db.insert("chatMessages", {
      conversationId: args.conversationId,
      role: args.role,
      content: args.content,
      tools: args.tools ?? [],
      ...(args.operationKey ? { operationKey: args.operationKey } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.pauseActions !== undefined ? { pauseActions: args.pauseActions } : {}),
      ...(args.runId !== undefined ? { runId: args.runId } : {}),
      createdAt: now,
      updatedAt: now,
    });
    await bumpMessageCount(ctx, args.conversationId);
    if (isSummaryMessage(args.role, args.status)) {
      await touchConversationSummary(ctx, args.conversationId, now);
    }
    return await ctx.db.get(id);
  },
});

export const updateMessage = mutation({
  args: {
    messageId,
    content: v.optional(v.string()),
    tools: v.optional(v.any()),
    status: v.optional(v.string()),
    pauseActions: v.optional(v.any()),
    runId: v.optional(v.id("agentRuns")),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.messageId);
    if (!existing) return null;
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of ["content", "tools", "status", "pauseActions", "runId"] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    await ctx.db.patch(args.messageId, patch as any);
    if (isSummaryTransition(existing, args.status)) {
      await touchConversationSummary(ctx, existing.conversationId, Date.now());
    }
    return await ctx.db.get(args.messageId);
  },
});

/** Retry-safe final-message write: the operation key identifies one logical message. */
export const upsertMessage = mutation({
  args: {
    conversationId,
    operationKey: v.string(),
    ...messageFields,
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatMessages")
      .withIndex("by_conversation_operationKey", (q) => q.eq("conversationId", args.conversationId).eq("operationKey", args.operationKey))
      .first();
    if (!existing) {
      const now = Date.now();
      const id = await ctx.db.insert("chatMessages", {
        conversationId: args.conversationId,
        operationKey: args.operationKey,
        role: args.role,
        content: args.content,
        tools: args.tools ?? [],
        ...(args.status !== undefined ? { status: args.status } : {}),
        ...(args.pauseActions !== undefined ? { pauseActions: args.pauseActions } : {}),
        ...(args.runId !== undefined ? { runId: args.runId } : {}),
        createdAt: now,
        updatedAt: now,
      });
      await bumpMessageCount(ctx, args.conversationId);
      if (isSummaryMessage(args.role, args.status)) {
        await touchConversationSummary(ctx, args.conversationId, now);
      }
      return await ctx.db.get(id);
    }
    const patch: Record<string, unknown> = {
      content: args.content,
      tools: args.tools ?? existing.tools,
      status: args.status ?? existing.status,
      pauseActions: args.pauseActions ?? existing.pauseActions,
      runId: args.runId ?? existing.runId,
      updatedAt: Date.now(),
    };
    await ctx.db.patch(existing._id, patch as any);
    // Existing assistant rows are commonly updated while a stream is being
    // projected. Only terminal/pause statuses move sidebar activity; token
    // updates intentionally touch the message row alone.
    if (isSummaryTransition(existing, args.status)) {
      await touchConversationSummary(ctx, args.conversationId, Date.now());
    }
    return await ctx.db.get(existing._id);
  },
});
