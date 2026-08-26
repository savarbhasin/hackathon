import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const timestamps = { createdAt: v.number(), updatedAt: v.number() };

export default defineSchema({
  // Product data mirrors the Prisma models while retaining the Phase 1 fields
  // used by the durable worker. Optional operation keys make retries safe.
  missions: defineTable({
    externalId: v.optional(v.string()),
    title: v.string(),
    goal: v.string(),
    status: v.string(),
    ...timestamps,
  })
    .index("by_externalId", ["externalId"])
    .index("by_status", ["status"])
    .index("by_createdAt", ["createdAt"]),

  tasks: defineTable({
    externalId: v.optional(v.string()),
    missionId: v.optional(v.id("missions")),
    title: v.string(),
    // Legacy Phase 0/1 names are kept for compatibility with the realtime spike.
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    detail: v.optional(v.string()),
    role: v.string(),
    agentPrompt: v.optional(v.string()),
    column: v.string(),
    status: v.optional(v.string()),
    dependsOn: v.array(v.id("tasks")),
    sessionId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    lastSeq: v.optional(v.number()),
    handoff: v.optional(v.any()),
    output: v.optional(v.any()),
    error: v.optional(v.string()),
    pendingActions: v.optional(v.any()),
    position: v.optional(v.number()),
    claimedBy: v.optional(v.string()),
    claimCount: v.optional(v.number()),
    operationKey: v.optional(v.string()),
    // Latest specialist run admitted for this task. It is retained after
    // completion so mark_done/finalization retries can prove ownership.
    specialistRunId: v.optional(v.id("agentRuns")),
    activeRunId: v.optional(v.id("agentRuns")),
    ...timestamps,
  })
    .index("by_externalId", ["externalId"])
    .index("by_operationKey", ["operationKey"])
    .index("by_specialistRun", ["specialistRunId"])
    .index("by_activeRun", ["activeRunId"])
    .index("by_mission", ["missionId", "position"])
    .index("by_column", ["column"])
    .index("by_mission_column", ["missionId", "column"]),

  taskEvents: defineTable({
    taskId: v.id("tasks"),
    seq: v.number(),
    type: v.string(),
    payload: v.any(),
    operationKey: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_task", ["taskId", "seq"])
    .index("by_task_operationKey", ["taskId", "operationKey"]),

  documents: defineTable({
    operationKey: v.optional(v.string()),
    missionId: v.optional(v.id("missions")),
    taskId: v.optional(v.id("tasks")),
    title: v.string(),
    content: v.string(),
    authorRole: v.string(),
    kind: v.string(),
    ...timestamps,
  })
    .index("by_operationKey", ["operationKey"])
    .index("by_mission", ["missionId", "updatedAt"])
    .index("by_task", ["taskId", "updatedAt"])
    .index("by_kind", ["kind"])
    .index("by_updatedAt", ["updatedAt"]),

  conversations: defineTable({
    operationKey: v.optional(v.string()),
    title: v.string(),
    // A session is normally seeded by the web enqueue path. It is optional
    // during creation so the worker can establish one durably on first run.
    sessionId: v.optional(v.string()),
    // Summary ordering is intentionally separate from updatedAt: assistant
    // token/message writes may update their own row without moving a sidebar
    // item. Older rows may omit these fields and are handled by query fallbacks.
    summaryUpdatedAt: v.optional(v.number()),
    messageCount: v.optional(v.number()),
    ...timestamps,
  })
    .index("by_operationKey", ["operationKey"])
    .index("by_sessionId", ["sessionId"])
    .index("by_updated", ["updatedAt"])
    .index("by_summaryUpdatedAt", ["summaryUpdatedAt"]),

  chatMessages: defineTable({
    conversationId: v.id("conversations"),
    operationKey: v.optional(v.string()),
    role: v.string(),
    content: v.string(),
    tools: v.any(),
    status: v.optional(v.string()),
    pauseActions: v.optional(v.any()),
    runId: v.optional(v.id("agentRuns")),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_conversation", ["conversationId", "createdAt"])
    .index("by_conversation_operationKey", ["conversationId", "operationKey"])
    .index("by_run", ["runId"]),

  agentProfiles: defineTable({
    slug: v.string(),
    name: v.string(),
    role: v.optional(v.string()),
    description: v.string(),
    instructions: v.string(),
    isDefault: v.boolean(),
    enabled: v.boolean(),
    operationKey: v.optional(v.string()),
    ...timestamps,
  })
    .index("by_slug", ["slug"])
    .index("by_operationKey", ["operationKey"])
    .index("by_role", ["role"])
    .index("by_enabled", ["enabled"])
    .index("by_updatedAt", ["updatedAt"]),

  // Schedule configuration is durable in Convex; BullMQ scheduler records are
  // only a reconciled delivery projection. Most of the fields are optional so
  // rows written by the Phase 1 spike remain readable without a backfill.
  schedules: defineTable({
    name: v.string(),
    cronExpr: v.string(),
    timezone: v.optional(v.string()),
    prompt: v.string(),
    enabled: v.boolean(),
    deletedAt: v.optional(v.number()),
    schedulerId: v.optional(v.string()),
    // Caller-owned admission key for idempotent create requests.
    operationKey: v.optional(v.string()),
    configRevision: v.optional(v.number()),
    configHash: v.optional(v.string()),
    syncState: v.optional(v.string()),
    syncError: v.optional(v.string()),
    syncedAt: v.optional(v.number()),
    lastRunAt: v.optional(v.number()),
    lastRunId: v.optional(v.id("agentRuns")),
    lastRunStatus: v.optional(v.string()),
    lastIntendedFireAt: v.optional(v.number()),
    lastFailureAt: v.optional(v.number()),
    lastFailureMessage: v.optional(v.string()),
    ...timestamps,
  })
    .index("by_enabled", ["enabled"])
    .index("by_schedulerId", ["schedulerId"])
    .index("by_operationKey", ["operationKey"])
    .index("by_deleted", ["deletedAt"])
    .index("by_syncState", ["syncState"]),

  pendingActions: defineTable({
    runId: v.id("agentRuns"),
    selector: v.optional(v.string()),
    kind: v.string(),
    payload: v.any(),
    consumedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index("by_run", ["runId", "createdAt"]).index("by_run_selector", ["runId", "selector"]),

  settings: defineTable({
    key: v.string(),
    value: v.any(),
    ...timestamps,
  }).index("by_key", ["key"]),

  agentRuns: defineTable({
    externalId: v.string(),
    operationKey: v.optional(v.string()),
    kind: v.string(),
    status: v.string(),
    conversationId: v.optional(v.id("conversations")),
    taskId: v.optional(v.id("tasks")),
    scheduleId: v.optional(v.id("schedules")),
    // Stable logical identity for recurring/manual schedule admissions. The
    // pair (scheduleId, scheduleFireKey) is deduped transactionally.
    scheduleFireKey: v.optional(v.string()),
    intendedFireAt: v.optional(v.number()),
    input: v.any(),
    createdAt: v.number(),
    output: v.optional(v.any()),
    errorCode: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    pendingActions: v.optional(v.any()),
    pendingActionSelector: v.optional(v.string()),
    pendingResume: v.optional(v.any()),
    sessionId: v.optional(v.string()),
    turnId: v.optional(v.string()),
    providerSequence: v.optional(v.number()),
    attempt: v.number(),
    claimedBy: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_operationKey", ["operationKey"])
    .index("by_conversation", ["conversationId", "createdAt"])
    .index("by_task", ["taskId", "createdAt"])
    .index("by_schedule", ["scheduleId", "createdAt"])
    .index("by_schedule_fireKey", ["scheduleId", "scheduleFireKey"])
    .index("by_status_updatedAt", ["status", "updatedAt"])
    .index("by_session_turn", ["sessionId", "turnId"]),

  runEvents: defineTable({
    runId: v.id("agentRuns"),
    sequence: v.number(),
    providerEventId: v.optional(v.string()),
    providerSequence: v.optional(v.number()),
    type: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index("by_run_sequence", ["runId", "sequence"])
    .index("by_run_providerEventId", ["runId", "providerEventId"]),
});
