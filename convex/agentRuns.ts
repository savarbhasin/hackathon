/* eslint-disable @typescript-eslint/no-explicit-any */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const guardArgs = {
  runId: v.id("agentRuns"),
  attempt: v.number(),
  workerId: v.string(),
};

const runSnapshot = v.object({
  _id: v.id("agentRuns"), _creationTime: v.number(), externalId: v.string(), kind: v.string(), status: v.string(),
  conversationId: v.optional(v.id("conversations")), taskId: v.optional(v.id("tasks")), scheduleId: v.optional(v.id("schedules")),
  scheduleFireKey: v.optional(v.string()), intendedFireAt: v.optional(v.number()),
  input: v.any(), createdAt: v.number(), output: v.optional(v.any()), errorCode: v.optional(v.string()), errorMessage: v.optional(v.string()),
  pendingActions: v.optional(v.any()), pendingActionSelector: v.optional(v.string()), pendingResume: v.optional(v.any()), resumeInput: v.optional(v.any()), sessionId: v.optional(v.string()), turnId: v.optional(v.string()),
  providerSequence: v.optional(v.number()), attempt: v.number(), claimedBy: v.optional(v.string()), startedAt: v.optional(v.number()), updatedAt: v.number(), finishedAt: v.optional(v.number()),
});

async function guardedRun(ctx: any, args: { runId: any; attempt: number; workerId: string }) {
  const run = await ctx.db.get(args.runId);
  if (!run || run.attempt !== args.attempt || run.claimedBy !== args.workerId) return null;
  return run;
}

export const get = query({
  args: { runId: v.id("agentRuns") },
  returns: v.union(runSnapshot, v.null()),
  handler: async (ctx, { runId }) => await ctx.db.get(runId),
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  returns: v.any(),
  handler: async (ctx, { externalId }) =>
    await ctx.db.query("agentRuns").withIndex("by_externalId", (q: any) => q.eq("externalId", externalId)).first(),
});

const activeStatuses = new Set(["queued", "enqueued", "connecting", "running", "waiting_for_user", "waiting_for_approval"]);

export const latestForConversation = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.query("agentRuns").withIndex("by_conversation", (q: any) => q.eq("conversationId", args.conversationId)).order("desc").first(),
});

export const activeForConversation = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const runs = await ctx.db.query("agentRuns").withIndex("by_conversation", (q: any) => q.eq("conversationId", args.conversationId)).order("desc").take(50);
    return runs.find((run: any) => activeStatuses.has(run.status)) ?? null;
  },
});

function runState(run: any, includePending = false): Record<string, unknown> {
  return {
    _id: run._id,
    _creationTime: run._creationTime,
    kind: run.kind,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
    ...(run.finishedAt !== undefined ? { finishedAt: run.finishedAt } : {}),
    ...(run.sessionId !== undefined ? { sessionId: run.sessionId } : {}),
    ...(run.turnId !== undefined ? { turnId: run.turnId } : {}),
    ...(includePending && run.pendingActions !== undefined ? { pendingActions: run.pendingActions } : {}),
    ...(includePending && run.pendingActionSelector !== undefined ? { pendingActionSelector: run.pendingActionSelector } : {}),
    ...(includePending && run.errorCode !== undefined ? { errorCode: run.errorCode } : {}),
    ...(includePending && run.errorMessage !== undefined ? { errorMessage: run.errorMessage } : {}),
    ...(includePending && run.output !== undefined ? { output: run.output } : {}),
  };
}

/** Narrow selected-conversation run state; no prompts, outputs, or runEvents. */
export const conversationRunState = query({
  args: { conversationId: v.id("conversations") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_conversation", (q: any) => q.eq("conversationId", args.conversationId))
      .order("desc")
      .take(100);
    const orchestratorRuns = runs.filter((run: any) => run.kind === "orchestrator");
    const latest = orchestratorRuns[0];
    const active = orchestratorRuns.find((run: any) => activeStatuses.has(run.status));
    return {
      latest: latest ? runState(latest) : null,
      active: active ? runState(active) : null,
    };
  },
});

export const latestForTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => await ctx.db.query("agentRuns").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("desc").first(),
});

export const activeForTask = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const runs = await ctx.db.query("agentRuns").withIndex("by_task", (q: any) => q.eq("taskId", args.taskId)).order("desc").take(50);
    return runs.find((run: any) => activeStatuses.has(run.status)) ?? null;
  },
});

/** Narrow selected-task run/pause state; prompts and provider event history stay out. */
export const taskRunState = query({
  args: { taskId: v.id("tasks") },
  returns: v.any(),
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("agentRuns")
      .withIndex("by_task", (q: any) => q.eq("taskId", args.taskId))
      .order("desc")
      .take(100);
    const specialistRuns = runs.filter((run: any) => run.kind === "specialist");
    const latest = specialistRuns[0];
    const active = specialistRuns.find((run: any) => activeStatuses.has(run.status));
    return {
      latest: latest ? runState(latest, true) : null,
      active: active ? runState(active, true) : null,
    };
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    kind: v.union(v.literal("orchestrator"), v.literal("specialist"), v.literal("schedule")),
    input: v.any(),
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    scheduleId: v.optional(v.id("schedules")),
    scheduleFireKey: v.optional(v.string()),
    intendedFireAt: v.optional(v.number()),
    // A resume or a pre-created provider session can seed the next turn.
    sessionId: v.optional(v.string()),
    turnId: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("agentRuns").withIndex("by_externalId", (q: any) => q.eq("externalId", args.externalId)).first();
    if (existing) return existing;
    const now = Date.now();
    const id = await ctx.db.insert("agentRuns", {
      externalId: args.externalId,
      kind: args.kind,
      status: "queued",
      input: args.input,
      ...(args.conversationId !== undefined ? { conversationId: args.conversationId } : {}),
      ...(args.taskId !== undefined ? { taskId: args.taskId } : {}),
      ...(args.scheduleId !== undefined ? { scheduleId: args.scheduleId } : {}),
      ...(args.scheduleFireKey !== undefined ? { scheduleFireKey: args.scheduleFireKey } : {}),
      ...(args.intendedFireAt !== undefined ? { intendedFireAt: args.intendedFireAt } : {}),
      ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
      ...(args.turnId !== undefined ? { turnId: args.turnId } : {}),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.get(id);
  },
});

export const markEnqueued = mutation({
  args: { runId: v.id("agentRuns") },
  returns: v.boolean(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "queued") return false;
    await ctx.db.patch(runId, { status: "enqueued", updatedAt: Date.now() });
    return true;
  },
});

export const claim = mutation({
  args: { runId: v.id("agentRuns"), workerId: v.string(), expectedAttempt: v.optional(v.number()) },
  returns: v.union(runSnapshot, v.null()),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return null;
    const activeRecovery = run.status === "connecting" || run.status === "running";
    const claimable = run.status === "queued" || run.status === "enqueued" || activeRecovery;
    if (!claimable) return null;
    // Active runs can only be reclaimed with an explicit matching attempt;
    // queued work may be claimed without one.
    if (activeRecovery && (args.expectedAttempt === undefined || run.attempt !== args.expectedAttempt)) return null;
    if (args.expectedAttempt !== undefined && run.attempt !== args.expectedAttempt) return null;
    const attempt = run.attempt + 1;
    await ctx.db.patch(args.runId, { status: "connecting", attempt, claimedBy: args.workerId, startedAt: run.startedAt ?? Date.now(), updatedAt: Date.now() });
    const updated = await ctx.db.get(args.runId);
    if (!updated) return null;
    return {
      ...updated,
      attempt,
      claimedBy: args.workerId,
      ...(run.pendingResume !== undefined ? { resumeInput: run.pendingResume } : {}),
    };
  },
});

export const releaseForRetry = mutation({
  args: { ...guardArgs, errorCode: v.string(), errorMessage: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await guardedRun(ctx, args);
    if (!run || (run.status !== "connecting" && run.status !== "running")) return false;
    await ctx.db.patch(args.runId, { status: "queued", errorCode: args.errorCode, errorMessage: args.errorMessage, claimedBy: undefined, updatedAt: Date.now() });
    return true;
  },
});

export const checkpointSession = mutation({
  args: { ...guardArgs, sessionId: v.string(), expectedSessionId: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await guardedRun(ctx, args);
    if (!run || run.status !== "connecting" || (args.expectedSessionId !== undefined && run.sessionId !== args.expectedSessionId)) return false;
    await ctx.db.patch(args.runId, { sessionId: args.sessionId, updatedAt: Date.now() });
    return true;
  },
});

export const checkpointSessionTurn = mutation({
  args: { ...guardArgs, sessionId: v.optional(v.string()), turnId: v.string(), expectedTurnId: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await guardedRun(ctx, args);
    if (!run || (run.status !== "connecting" && run.status !== "running") || (args.expectedTurnId !== undefined && run.turnId !== args.expectedTurnId)) return false;
    await ctx.db.patch(args.runId, { sessionId: args.sessionId, turnId: args.turnId, status: "running", updatedAt: Date.now() });
    return true;
  },
});

export const checkpointProviderCursor = mutation({
  args: { ...guardArgs, turnId: v.string(), providerSequence: v.number() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await guardedRun(ctx, args);
    if (!run || run.turnId !== args.turnId || (run.providerSequence !== undefined && args.providerSequence < run.providerSequence)) return false;
    await ctx.db.patch(args.runId, { providerSequence: args.providerSequence, updatedAt: Date.now() });
    return true;
  },
});

export const appendProviderEvent = mutation({
  args: { ...guardArgs, turnId: v.string(), sequence: v.number(), providerEventId: v.optional(v.string()), providerSequence: v.optional(v.number()), type: v.string(), payload: v.any() },
  returns: v.object({ inserted: v.boolean(), id: v.id("runEvents") }),
  handler: async (ctx, args) => {
    const run = await guardedRun(ctx, args);
    if (!run || run.turnId !== args.turnId) throw new Error("run ownership or turn mismatch");
    const duplicate = args.providerEventId
      ? await ctx.db.query("runEvents").withIndex("by_run_providerEventId", (q: any) => q.eq("runId", args.runId).eq("providerEventId", args.providerEventId)).first()
      : await ctx.db.query("runEvents").withIndex("by_run_sequence", (q: any) => q.eq("runId", args.runId).eq("sequence", args.sequence)).first();
    if (duplicate) return { inserted: false, id: duplicate._id };
    const id = await ctx.db.insert("runEvents", { runId: args.runId, sequence: args.sequence, providerEventId: args.providerEventId, providerSequence: args.providerSequence, type: args.type, payload: args.payload, createdAt: Date.now() });
    return { inserted: true, id };
  },
});

export const waitForUser = mutation({
  args: { ...guardArgs, pendingActions: v.any(), pendingActionSelector: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => transition(ctx, args, "waiting_for_user", {
    pendingActions: args.pendingActions,
    pendingActionSelector: pendingSelector(args.pendingActions, args.pendingActionSelector),
  }),
});
export const waitForApproval = mutation({
  args: { ...guardArgs, pendingActions: v.any(), pendingActionSelector: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => transition(ctx, args, "waiting_for_approval", {
    pendingActions: args.pendingActions,
    pendingActionSelector: pendingSelector(args.pendingActions, args.pendingActionSelector),
  }),
});

const scheduleOutcomeStatuses = new Set([
  "waiting_for_user",
  "waiting_for_approval",
  "completed",
  "failed",
  "cancelled",
]);

function scheduleOutcomeRank(status: string | undefined): number {
  if (status === "completed" || status === "failed" || status === "cancelled") return 2;
  if (status === "waiting_for_user" || status === "waiting_for_approval") return 1;
  return 0;
}

/**
 * Project the first durable delivery outcome for a schedule run. This runs in
 * the same Convex transaction as the guarded run transition, so stale workers
 * cannot publish an outcome after losing their run lease. `intendedFireAt` is
 * deliberately used instead of completion wall-clock time: an older fire can
 * never move the schedule UI backwards.
 */
async function projectScheduleOutcome(ctx: any, run: any, status: string): Promise<void> {
  if (run.kind !== "schedule" || !run.scheduleId || !scheduleOutcomeStatuses.has(status)) return;
  const schedule = await ctx.db.get(run.scheduleId);
  if (!schedule) return;
  const intendedFireAt = typeof run.intendedFireAt === "number" && Number.isFinite(run.intendedFireAt)
    ? run.intendedFireAt
    : run.createdAt;
  const previousFireAt = typeof schedule.lastIntendedFireAt === "number" ? schedule.lastIntendedFireAt : undefined;
  const incomingRank = scheduleOutcomeRank(status);
  const previousRank = scheduleOutcomeRank(schedule.lastRunStatus);
  if (previousFireAt !== undefined && intendedFireAt < previousFireAt) return;
  // A duplicate callback for the same run is harmless. If the run advances
  // from waiting to terminal, allow the higher-ranked terminal projection.
  if (previousFireAt === intendedFireAt && schedule.lastRunId === run._id && previousRank >= incomingRank) return;

  const patch: Record<string, unknown> = {
    lastRunAt: intendedFireAt,
    lastRunId: run._id,
    lastRunStatus: status,
    lastIntendedFireAt: intendedFireAt,
    updatedAt: Date.now(),
  };
  if (status === "failed") {
    // Failure time is the observed lifecycle time; lastRunAt remains the
    // logical intended-fire timestamp used for schedule ordering.
    patch.lastFailureAt = Date.now();
    patch.lastFailureMessage = typeof run.errorMessage === "string" ? run.errorMessage : "Schedule run failed";
  }
  await ctx.db.patch(run.scheduleId, patch);
}

async function transition(ctx: any, args: any, status: string, extra: any) {
  const run = await guardedRun(ctx, args);
  if (!run) return false;
  await ctx.db.patch(args.runId, { status, ...extra, updatedAt: Date.now() });
  await projectScheduleOutcome(ctx, { ...run, status, ...extra }, status);
  return true;
}

export const complete = mutation({
  args: { ...guardArgs, turnId: v.string(), output: v.any() },
  returns: v.boolean(),
  handler: async (ctx, args) => finish(ctx, args, "completed", { output: args.output, finishedAt: Date.now() }),
});
export const fail = mutation({
  args: { ...guardArgs, turnId: v.optional(v.string()), errorCode: v.string(), errorMessage: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => finish(ctx, args, "failed", { errorCode: args.errorCode, errorMessage: args.errorMessage, finishedAt: Date.now() }),
});
export const cancel = mutation({
  args: { ...guardArgs, turnId: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => finish(ctx, args, "cancelled", { finishedAt: Date.now() }),
});

async function finish(ctx: any, args: any, status: string, extra: any) {
  const run = await guardedRun(ctx, args);
  if (!run || (args.turnId !== undefined && run.turnId !== args.turnId)) return false;
  await ctx.db.patch(args.runId, { status, ...extra, updatedAt: Date.now() });
  await projectScheduleOutcome(ctx, { ...run, status, ...extra }, status);
  return true;
}

function actionSelectors(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(actionSelectors);
  const record = value as Record<string, unknown>;
  const selectors: string[] = [];
  for (const key of ["selector", "id", "toolCallId", "sourceEventId"]) {
    if (typeof record[key] === "string" && record[key]) selectors.push(record[key] as string);
  }
  return selectors.concat(...Object.values(record).map(actionSelectors));
}

function selectorMatches(run: any, selector: string | undefined): boolean {
  if (!selector) return false;
  if (run.pendingActionSelector === selector) return true;
  return actionSelectors(run.pendingActions).includes(selector);
}

function pendingSelector(pendingActions: unknown, explicit: string | undefined): string | undefined {
  if (explicit) return explicit;
  const selectors = [...new Set(actionSelectors(pendingActions))];
  return selectors.length === 1 ? selectors[0] : undefined;
}

export const queueResume = mutation({
  args: { runId: v.id("agentRuns"), pendingAction: v.optional(v.any()), pendingActionSelector: v.optional(v.string()), resumeInput: v.any() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run) return false;

    // A retried admission is idempotent once the same run is already queued.
    // Keep the pending action until the worker checkpoints the replacement turn.
    if (run.status === "queued" || run.status === "enqueued") {
      return run.pendingResume !== undefined && JSON.stringify(run.pendingResume) === JSON.stringify(args.resumeInput);
    }
    if (run.status !== "waiting_for_user" && run.status !== "waiting_for_approval") return false;

    const valid = args.pendingActionSelector
      ? selectorMatches(run, args.pendingActionSelector)
      : args.pendingAction !== undefined && JSON.stringify(run.pendingActions) === JSON.stringify(args.pendingAction);
    if (!valid) return false;
    await ctx.db.patch(args.runId, {
      status: "queued",
      pendingResume: args.resumeInput,
      claimedBy: undefined,
      updatedAt: Date.now(),
    });
    return true;
  },
});

export const acceptResume = mutation({
  args: { ...guardArgs, turnId: v.string(), pendingAction: v.optional(v.any()), pendingActionSelector: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const run = await guardedRun(ctx, args);
    if (!run || run.turnId !== args.turnId) return false;
    const valid = args.pendingActionSelector
      ? selectorMatches(run, args.pendingActionSelector)
      : args.pendingAction !== undefined && JSON.stringify(run.pendingActions) === JSON.stringify(args.pendingAction);
    if (!valid) return false;
    await ctx.db.patch(args.runId, { pendingActions: undefined, pendingActionSelector: undefined, pendingResume: undefined, updatedAt: Date.now() });
    return true;
  },
});
