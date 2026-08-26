/* eslint-disable @typescript-eslint/no-explicit-any */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const UTC = "UTC";
const MAX_LIMIT = 500;

/** BullMQ scheduler identity. It is intentionally derived only from Convex ID. */
function schedulerIdentity(scheduleId: string): string {
  return `mission-control:schedule:${scheduleId}`;
}

function normalizeTimezone(value: string | undefined): string {
  return value?.trim() || UTC;
}

/** Fire times are persisted as integer Unix milliseconds (UTC has no offset). */
function normalizeIntendedFireAt(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = Math.trunc(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : null;
}

function hashConfig(name: string, cronExpr: string, timezone: string, prompt: string, enabled: boolean): string {
  // Small deterministic hash suitable for reconciliation comparisons. The
  // scheduler never treats this as a security digest.
  const input = JSON.stringify({ name, cronExpr, timezone, prompt, enabled });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function normalizedSchedule(schedule: any): any {
  const timezone = normalizeTimezone(schedule.timezone);
  const schedulerId = schedule.schedulerId ?? schedulerIdentity(String(schedule._id));
  const configRevision = typeof schedule.configRevision === "number" ? schedule.configRevision : 1;
  const configHash = schedule.configHash ?? hashConfig(schedule.name, schedule.cronExpr, timezone, schedule.prompt, schedule.enabled);
  return {
    ...schedule,
    timezone,
    schedulerId,
    configRevision,
    configHash,
    syncState: schedule.syncState ?? "pending",
  };
}

function cap(value: number | undefined): number {
  return Math.max(1, Math.min(MAX_LIMIT, value ?? 100));
}

function configPatch(schedule: any, changes: { name?: string; cronExpr?: string; timezone?: string; prompt?: string; enabled?: boolean }, now: number): any {
  const name = changes.name ?? schedule.name;
  const cronExpr = changes.cronExpr ?? schedule.cronExpr;
  const timezone = normalizeTimezone(changes.timezone ?? schedule.timezone);
  const prompt = changes.prompt ?? schedule.prompt;
  const enabled = changes.enabled ?? schedule.enabled;
  return {
    ...(changes.name !== undefined ? { name } : {}),
    ...(changes.cronExpr !== undefined ? { cronExpr } : {}),
    timezone,
    ...(changes.prompt !== undefined ? { prompt } : {}),
    ...(changes.enabled !== undefined ? { enabled } : {}),
    configRevision: (typeof schedule.configRevision === "number" ? schedule.configRevision : 1) + 1,
    configHash: hashConfig(name, cronExpr, timezone, prompt, enabled),
    syncState: "pending",
    syncError: undefined,
    syncedAt: undefined,
    updatedAt: now,
  };
}

export const get = query({
  args: { scheduleId: v.id("schedules") },
  returns: v.any(),
  handler: async (ctx, { scheduleId }) => {
    const schedule = await ctx.db.get(scheduleId);
    return schedule ? normalizedSchedule(schedule) : null;
  },
});

export const list = query({
  args: { limit: v.optional(v.number()), includeDeleted: v.optional(v.boolean()), includeDisabled: v.optional(v.boolean()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("schedules").order("desc").take(cap(args.limit));
    return rows
      .filter((schedule: any) => (args.includeDeleted || schedule.deletedAt === undefined)
        && (args.includeDisabled || schedule.enabled))
      .map(normalizedSchedule);
  },
});

/** Snapshot consumed by the BullMQ scheduler reconciler; disabled/deleted rows
 * remain tombstones so stale scheduler IDs can be removed. */
export const reconciliationSnapshot = query({
  args: { limit: v.optional(v.number()) },
  returns: v.any(),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("schedules").order("asc").take(cap(args.limit));
    const schedules: any[] = [];
    const tombstones: any[] = [];
    for (const row of rows) {
      const schedule = normalizedSchedule(row);
      if (schedule.deletedAt !== undefined || !schedule.enabled) tombstones.push({
        _id: schedule._id,
        schedulerId: schedule.schedulerId,
        configRevision: schedule.configRevision,
        deletedAt: schedule.deletedAt ?? null,
        enabled: schedule.enabled,
      });
      else schedules.push(schedule);
    }
    return { schedules, tombstones };
  },
});

export const create = mutation({
  args: {
    name: v.string(), cronExpr: v.string(), timezone: v.optional(v.string()), prompt: v.string(), enabled: v.optional(v.boolean()),
    operationKey: v.optional(v.string()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const operationKey = args.operationKey?.trim() || undefined;
    if (operationKey) {
      const existing = await ctx.db.query("schedules")
        .withIndex("by_operationKey", (q: any) => q.eq("operationKey", operationKey))
        .first();
      // The operation key is the caller's logical create identity. Return the
      // existing row (including a tombstone) rather than creating a duplicate.
      if (existing) return normalizedSchedule(existing);
    }
    const now = Date.now();
    const timezone = normalizeTimezone(args.timezone);
    const enabled = args.enabled ?? true;
    const id = await ctx.db.insert("schedules", {
      name: args.name,
      cronExpr: args.cronExpr,
      timezone,
      prompt: args.prompt,
      enabled,
      schedulerId: "pending",
      ...(operationKey !== undefined ? { operationKey } : {}),
      configRevision: 1,
      configHash: hashConfig(args.name, args.cronExpr, timezone, args.prompt, enabled),
      syncState: "pending",
      createdAt: now,
      updatedAt: now,
    });
    const schedulerId = schedulerIdentity(String(id));
    await ctx.db.patch(id, { schedulerId });
    return normalizedSchedule(await ctx.db.get(id));
  },
});

export const update = mutation({
  args: {
    scheduleId: v.id("schedules"), name: v.optional(v.string()), cronExpr: v.optional(v.string()), timezone: v.optional(v.string()),
    prompt: v.optional(v.string()), enabled: v.optional(v.boolean()),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule || schedule.deletedAt !== undefined) return { outcome: "not_found" };
    const now = Date.now();
    await ctx.db.patch(args.scheduleId, configPatch(schedule, args, now));
    return { outcome: "updated", schedule: normalizedSchedule(await ctx.db.get(args.scheduleId)) };
  },
});

async function setEnabledInternal(ctx: any, scheduleId: any, enabled: boolean): Promise<any> {
  const schedule = await ctx.db.get(scheduleId);
  if (!schedule || schedule.deletedAt !== undefined) return { outcome: "not_found" };
  if (schedule.enabled === enabled) return { outcome: "idempotent", schedule: normalizedSchedule(schedule) };
  await ctx.db.patch(scheduleId, configPatch(schedule, { enabled }, Date.now()));
  return { outcome: "updated", schedule: normalizedSchedule(await ctx.db.get(scheduleId)) };
}

export const setEnabled = mutation({
  args: { scheduleId: v.id("schedules"), enabled: v.boolean() },
  returns: v.any(),
  handler: async (ctx, args) => await setEnabledInternal(ctx, args.scheduleId, args.enabled),
});
export const enable = mutation({
  args: { scheduleId: v.id("schedules") }, returns: v.any(),
  handler: async (ctx, { scheduleId }) => await setEnabledInternal(ctx, scheduleId, true),
});
export const disable = mutation({
  args: { scheduleId: v.id("schedules") }, returns: v.any(),
  handler: async (ctx, { scheduleId }) => await setEnabledInternal(ctx, scheduleId, false),
});

export const deleteSchedule = mutation({
  args: { scheduleId: v.id("schedules") },
  returns: v.any(),
  handler: async (ctx, { scheduleId }) => {
    const schedule = await ctx.db.get(scheduleId);
    if (!schedule) return { outcome: "not_found" };
    if (schedule.deletedAt !== undefined) return { outcome: "idempotent", schedulerId: schedulerIdentity(String(scheduleId)) };
    const now = Date.now();
    await ctx.db.patch(scheduleId, {
      enabled: false,
      deletedAt: now,
      schedulerId: schedule.schedulerId ?? schedulerIdentity(String(scheduleId)),
      configRevision: (typeof schedule.configRevision === "number" ? schedule.configRevision : 1) + 1,
      configHash: hashConfig(schedule.name, schedule.cronExpr, normalizeTimezone(schedule.timezone), schedule.prompt, false),
      syncState: "pending",
      syncError: undefined,
      syncedAt: undefined,
      updatedAt: now,
    });
    return { outcome: "deleted", schedulerId: schedule.schedulerId ?? schedulerIdentity(String(scheduleId)) };
  },
});

export const markSyncSuccess = mutation({
  args: { scheduleId: v.id("schedules"), configRevision: v.number(), schedulerId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return { outcome: "not_found" };
    const expectedId = schedule.schedulerId ?? schedulerIdentity(String(args.scheduleId));
    if (args.schedulerId !== expectedId || (schedule.configRevision ?? 1) !== args.configRevision) return { outcome: "stale" };
    await ctx.db.patch(args.scheduleId, { syncState: "synced", syncError: undefined, syncedAt: Date.now(), updatedAt: Date.now() });
    return { outcome: "updated" };
  },
});

export const markSyncFailure = mutation({
  // A failed create may not have a BullMQ scheduler ID yet; revision is still
  // mandatory so an older reconciliation cannot overwrite newer state.
  args: { scheduleId: v.id("schedules"), configRevision: v.number(), schedulerId: v.optional(v.string()), error: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const schedule = await ctx.db.get(args.scheduleId);
    if (!schedule) return { outcome: "not_found" };
    const expectedId = schedule.schedulerId ?? schedulerIdentity(String(args.scheduleId));
    if ((args.schedulerId !== undefined && args.schedulerId !== expectedId) || (schedule.configRevision ?? 1) !== args.configRevision) return { outcome: "stale" };
    await ctx.db.patch(args.scheduleId, { syncState: "error", syncError: args.error.slice(0, 2000), syncedAt: Date.now(), updatedAt: Date.now() });
    return { outcome: "updated" };
  },
});

const fireArgs = {
  scheduleId: v.id("schedules"),
  intendedFireAt: v.optional(v.number()),
  fireKey: v.optional(v.string()),
  requestId: v.optional(v.string()),
  externalId: v.optional(v.string()),
};

type FireInput = { scheduleId: any; intendedFireAt?: number; fireKey?: string; requestId?: string; externalId?: string; manual?: boolean };

async function admitFire(ctx: any, args: FireInput): Promise<any> {
  const schedule = await ctx.db.get(args.scheduleId);
  if (!schedule || schedule.deletedAt !== undefined) return { outcome: "not_found" };
  if (!schedule.enabled) return { outcome: "disabled" };
  const normalizedTime = args.intendedFireAt === undefined ? null : normalizeIntendedFireAt(args.intendedFireAt);
  if (args.intendedFireAt !== undefined && normalizedTime === null) return { outcome: "invalid_state", reason: "intendedFireAt must be a non-negative safe integer in UTC milliseconds" };
  const suppliedManualKey = (args.fireKey ?? args.requestId)?.trim();
  if (normalizedTime === null && !suppliedManualKey) return { outcome: "invalid_state", reason: "recurring fires require intendedFireAt; manual fires require fireKey/requestId" };
  // Scheduled fires are keyed by normalized UTC time. A manual run-now is
  // always keyed by the caller's request UUID, even when it supplies an
  // explicit intended timestamp.
  const scheduleFireKey = args.manual || normalizedTime === null
    ? `manual:${suppliedManualKey}`
    : `utc:${normalizedTime}`;
  const externalId = args.externalId?.trim() || `schedule:${String(args.scheduleId)}:${scheduleFireKey}`;

  const byExternal = await ctx.db.query("agentRuns").withIndex("by_externalId", (q: any) => q.eq("externalId", externalId)).first();
  if (byExternal) {
    if (byExternal.kind !== "schedule"
      || String(byExternal.scheduleId) !== String(args.scheduleId)
      || byExternal.scheduleFireKey !== scheduleFireKey) {
      return { outcome: "conflict", reason: "externalId is already linked to another fire" };
    }
    return { outcome: "idempotent", run: byExternal, runId: byExternal._id };
  }
  const byFire = await ctx.db.query("agentRuns").withIndex("by_schedule_fireKey", (q: any) => q.eq("scheduleId", args.scheduleId).eq("scheduleFireKey", scheduleFireKey)).first();
  if (byFire) {
    if (byFire.kind !== "schedule") return { outcome: "conflict", reason: "fire key is already linked to a non-schedule run" };
    return { outcome: "idempotent", run: byFire, runId: byFire._id };
  }

  const now = Date.now();
  const intendedFireAt = normalizedTime ?? now;
  const id = await ctx.db.insert("agentRuns", {
    externalId,
    kind: "schedule",
    status: "queued",
    scheduleId: args.scheduleId,
    scheduleFireKey,
    intendedFireAt,
    input: {
      agentName: "orchestrator",
      items: [{ type: "user.message", content: schedule.prompt }],
      scheduleId: String(args.scheduleId),
      intendedFireAt,
    },
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  });
  const run = await ctx.db.get(id);
  return { outcome: "created", run, runId: id };
}

/** Admit a scheduler-delivered fire. Recurring identity is UTC fire time. */
export const createScheduledRun = mutation({
  args: fireArgs,
  returns: v.any(),
  handler: async (ctx, args) => await admitFire(ctx, args),
});

/** Admit an explicit run-now request. requestId must be a caller-owned stable UUID. */
export const runNow = mutation({
  args: { scheduleId: v.id("schedules"), requestId: v.string(), intendedFireAt: v.optional(v.number()), externalId: v.optional(v.string()) },
  returns: v.any(),
  handler: async (ctx, args) => await admitFire(ctx, { ...args, fireKey: args.requestId, manual: true }),
});

// Alias for scheduler integrations that call the operation "fire".
export const fire = mutation({
  args: fireArgs,
  returns: v.any(),
  handler: async (ctx, args) => await admitFire(ctx, args),
});
