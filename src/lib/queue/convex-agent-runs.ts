import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { convexUrl } from "./env";
import type {
  AgentRunKind,
  AgentRunRecord,
  AgentRunStore,
  PendingAction,
  ProviderEventCheckpoint,
  ScheduleReconciliationSnapshot,
} from "./types";

function runId(runId: string): never {
  // Generated Convex IDs are opaque at compile time; values originate in Convex
  // and are only ever placed unchanged into BullMQ's runId-only payload.
  return runId as never;
}

function asRecord(value: unknown): AgentRunRecord | null {
  return value ? value as AgentRunRecord : null;
}

/** Server-side adapter for the durable production `api.agentRuns.*` contract. */
export type ScheduleFireAdmission = {
  scheduleId: string;
  intendedFireAt?: number;
  fireKey: string;
  requestId?: string;
  externalId?: string;
};

/** Server-only adapter for the durable `api.schedules.*` worker contract. */
export class ConvexScheduleStore {
  private readonly client: ConvexHttpClient;

  constructor(url = convexUrl()) {
    this.client = new ConvexHttpClient(url, { logger: false });
  }

  async reconciliationSnapshot(limit: number): Promise<ScheduleReconciliationSnapshot> {
    const value = await this.client.query((anyApi as any).schedules.reconciliationSnapshot, { limit });
    const snapshot = value as { schedules?: unknown; tombstones?: unknown };
    return {
      schedules: Array.isArray(snapshot?.schedules) ? snapshot.schedules as ScheduleReconciliationSnapshot["schedules"] : [],
      tombstones: Array.isArray(snapshot?.tombstones) ? snapshot.tombstones as ScheduleReconciliationSnapshot["tombstones"] : [],
    };
  }

  async markSyncSuccess(input: { scheduleId: string; configRevision: number; schedulerId: string }): Promise<unknown> {
    return await this.client.mutation((anyApi as any).schedules.markSyncSuccess, {
      scheduleId: runId(input.scheduleId),
      configRevision: input.configRevision,
      schedulerId: input.schedulerId,
    });
  }

  async markSyncFailure(input: { scheduleId: string; configRevision: number; schedulerId?: string; error: string }): Promise<unknown> {
    return await this.client.mutation((anyApi as any).schedules.markSyncFailure, {
      scheduleId: runId(input.scheduleId),
      configRevision: input.configRevision,
      ...(input.schedulerId ? { schedulerId: input.schedulerId } : {}),
      error: input.error.slice(0, 2000),
    });
  }

  async createScheduledRun(input: ScheduleFireAdmission): Promise<{ outcome?: string; runId?: string; run?: AgentRunRecord; reason?: string }> {
    return await this.client.mutation((anyApi as any).schedules.createScheduledRun, {
      scheduleId: runId(input.scheduleId),
      fireKey: input.fireKey,
      ...(input.intendedFireAt !== undefined ? { intendedFireAt: input.intendedFireAt } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
    }) as { outcome?: string; runId?: string; run?: AgentRunRecord; reason?: string };
  }
}

export class ConvexAgentRunStore implements AgentRunStore {
  private readonly client: ConvexHttpClient;

  constructor(url = convexUrl()) {
    this.client = new ConvexHttpClient(url, { logger: false });
  }

  async get(runIdValue: string): Promise<AgentRunRecord | null> {
    // `get` is deliberately by Convex _id: worker jobs contain no external ID.
    return asRecord(await this.client.query(api.agentRuns.get, { runId: runId(runIdValue) }));
  }

  async create(input: {
    externalId: string;
    kind: AgentRunKind;
    input: unknown;
    conversationId?: string;
    taskId?: string;
    scheduleId?: string;
    sessionId?: string;
    turnId?: string;
  }): Promise<AgentRunRecord> {
    const { conversationId, taskId, scheduleId, ...run } = input;
    return (await this.client.mutation(api.agentRuns.create, {
      ...run,
      ...(conversationId ? { conversationId: runId(conversationId) } : {}),
      ...(taskId ? { taskId: runId(taskId) } : {}),
      ...(scheduleId ? { scheduleId: runId(scheduleId) } : {}),
    })) as AgentRunRecord;
  }

  async markEnqueued(runIdValue: string): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.markEnqueued, { runId: runId(runIdValue) });
  }

  async claim(input: { runId: string; workerId: string; expectedAttempt?: number }): Promise<AgentRunRecord | null> {
    return asRecord(await this.client.mutation(api.agentRuns.claim, { ...input, runId: runId(input.runId) }));
  }

  async checkpointSession(input: { runId: string; attempt: number; workerId: string; sessionId: string; expectedSessionId?: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.checkpointSession, { ...input, runId: runId(input.runId) });
  }

  async checkpointSessionTurn(input: { runId: string; attempt: number; workerId: string; sessionId?: string; turnId: string; expectedTurnId?: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.checkpointSessionTurn, { ...input, runId: runId(input.runId) });
  }

  async checkpointProviderCursor(input: { runId: string; attempt: number; workerId: string; turnId: string; providerSequence: number }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.checkpointProviderCursor, { ...input, runId: runId(input.runId) });
  }

  async appendProviderEvent(input: ProviderEventCheckpoint): Promise<{ inserted: boolean; id: string }> {
    return await this.client.mutation(api.agentRuns.appendProviderEvent, { ...input, runId: runId(input.runId) });
  }

  async appendProviderEventAndCheckpoint(input: ProviderEventCheckpoint & { providerSequence: number }): Promise<{ inserted: boolean; id: string | null; checkpointed: boolean } | null> {
    const value = await this.client.mutation(anyApi.agentRuns.appendProviderEventAndCheckpoint, { ...input, runId: runId(input.runId) });
    if (!value || typeof value !== "object") return null;
    const row = value as { inserted?: unknown; id?: unknown; checkpointed?: unknown };
    return {
      inserted: row.inserted === true,
      id: typeof row.id === "string" ? row.id : null,
      checkpointed: row.checkpointed === true,
    };
  }

  async getRecoveryModelEvents(runIdValue: string, throughSequence: number): Promise<Array<{ sequence: number; type: string; payload: Record<string, unknown> }>> {
    const value = await this.client.query(anyApi.agentRuns.recoveryModelEvents, {
      runId: runId(runIdValue),
      throughSequence,
    });
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as { sequence?: unknown; type?: unknown; payload?: unknown };
      if (typeof row.sequence !== "number" || typeof row.type !== "string" || !row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)) return [];
      return [{ sequence: row.sequence, type: row.type, payload: row.payload as Record<string, unknown> }];
    });
  }

  async waitForUser(input: { runId: string; attempt: number; workerId: string; pendingActions: PendingAction[]; pendingActionSelector?: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.waitForUser, { ...input, runId: runId(input.runId) });
  }

  async waitForApproval(input: { runId: string; attempt: number; workerId: string; pendingActions: PendingAction[]; pendingActionSelector?: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.waitForApproval, { ...input, runId: runId(input.runId) });
  }

  async complete(input: { runId: string; attempt: number; workerId: string; turnId: string; output: Record<string, unknown> | null }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.complete, { ...input, runId: runId(input.runId) });
  }

  async fail(input: { runId: string; attempt: number; workerId: string; turnId?: string; errorCode: string; errorMessage: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.fail, { ...input, runId: runId(input.runId) });
  }

  async cancel(input: { runId: string; attempt: number; workerId: string; turnId?: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.cancel, { ...input, runId: runId(input.runId) });
  }

  async queueResume(input: {
    runId: string;
    pendingAction?: PendingAction[];
    pendingActionSelector?: string;
    resumeInput: unknown;
  }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.queueResume, { ...input, runId: runId(input.runId) });
  }

  async acceptResume(input: {
    runId: string;
    attempt: number;
    workerId: string;
    turnId: string;
    pendingAction?: PendingAction[];
    pendingActionSelector?: string;
  }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.acceptResume, { ...input, runId: runId(input.runId) });
  }

  async releaseForRetry(input: { runId: string; attempt: number; workerId: string; errorCode: string; errorMessage: string }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.releaseForRetry, { ...input, runId: runId(input.runId) });
  }

  async getDocument(documentId: string): Promise<{ title: string; content: string } | null> {
    const document = await this.client.query(anyApi.documents.get, { documentId: runId(documentId) });
    if (!document || typeof document !== "object") return null;
    const value = document as { title?: unknown; content?: unknown };
    if (typeof value.title !== "string" || typeof value.content !== "string") return null;
    return { title: value.title, content: value.content };
  }

  async getConversationSession(conversationId: string): Promise<string | null> {
    const conversation = await this.client.query(anyApi.conversations.get, { conversationId: runId(conversationId) });
    if (!conversation || typeof conversation !== "object") return null;
    return typeof (conversation as { sessionId?: unknown }).sessionId === "string"
      ? (conversation as { sessionId: string }).sessionId
      : null;
  }

  async getAssistantMessage(conversationId: string, operationKey: string): Promise<{ content: string; tools: string[] } | null> {
    const value = await this.client.query(anyApi.conversations.getMessageByOperationKey, {
      conversationId: runId(conversationId),
      operationKey,
    });
    if (!value || typeof value !== "object") return null;
    const row = value as { content?: unknown; tools?: unknown };
    return {
      content: typeof row.content === "string" ? row.content : "",
      tools: Array.isArray(row.tools) ? row.tools.filter((tool): tool is string => typeof tool === "string") : [],
    };
  }

  async checkpointConversationSession(input: { conversationId: string; sessionId: string; expectedSessionId?: string }): Promise<boolean> {
    return await this.client.mutation(anyApi.conversations.checkpointSession, {
      conversationId: runId(input.conversationId),
      sessionId: input.sessionId,
      ...(input.expectedSessionId !== undefined ? { expectedSessionId: input.expectedSessionId } : {}),
    });
  }

  async upsertAssistantMessage(input: {
    conversationId: string;
    runId: string;
    operationKey: string;
    content: string;
    tools: string[];
    status: string;
    pauseActions?: PendingAction[];
    attempt?: number;
    workerId?: string;
  }): Promise<unknown> {
    return await this.client.mutation(anyApi.conversations.upsertMessage, {
      conversationId: runId(input.conversationId),
      runId: runId(input.runId),
      operationKey: input.operationKey,
      role: "assistant",
      content: input.content,
      tools: input.tools,
      status: input.status,
      ...(input.pauseActions !== undefined ? { pauseActions: input.pauseActions } : {}),
      ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      ...(input.workerId !== undefined ? { workerId: input.workerId } : {}),
    });
  }

  async checkpointSpecialist(input: { taskId: string; runId: string; sessionId?: string; turnId?: string }): Promise<boolean> {
    return await this.client.mutation(anyApi.missions.checkpointSpecialist, {
      taskId: runId(input.taskId),
      runId: runId(input.runId),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
    });
  }

  async appendTaskEvent(input: { taskId: string; type: string; payload: unknown; operationKey: string }): Promise<unknown> {
    return await this.client.mutation(anyApi.missions.appendTaskEvent, {
      taskId: runId(input.taskId),
      type: input.type,
      payload: input.payload,
      operationKey: input.operationKey,
    });
  }

  async finalizeSpecialist(input: {
    taskId: string;
    runId: string;
    status: "completed" | "waiting_for_approval" | "waiting_for_user" | "failed" | "cancelled";
    sessionId?: string;
    turnId?: string;
    output?: unknown;
    pendingActions?: PendingAction[];
    pendingActionSelector?: string;
    errorCode?: string;
    errorMessage?: string;
    operationKey: string;
  }): Promise<unknown> {
    return await this.client.mutation(anyApi.missions.finalizeSpecialist, {
      taskId: runId(input.taskId),
      runId: runId(input.runId),
      status: input.status,
      operationKey: input.operationKey,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.pendingActions !== undefined ? { pendingActions: input.pendingActions } : {}),
      ...(input.pendingActionSelector !== undefined ? { pendingActionSelector: input.pendingActionSelector } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
    });
  }

  async readySuccessors(taskId: string): Promise<unknown> {
    return await this.client.query(anyApi.missions.readySuccessors, { taskId: runId(taskId) });
  }
}
