import { DeltaStreamer, compressUIMessageChunks } from "@convex-dev/agent";
import type { UIMessageChunk } from "ai";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { api } from "../../../convex/_generated/api";
import { convexUrl } from "./env";
import { AssistantToolStreamProjector } from "./assistant-tool-stream";
import type {
  AgentRunKind,
  AgentRunRecord,
  AgentRunStore,
  AssistantDeltaStream,
  AssistantMessagePart,
  PendingAction,
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

  async waitForUser(input: { runId: string; attempt: number; workerId: string; turnId: string; pendingActions: PendingAction[]; pendingActionSelector?: string; providerSequence?: number }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.waitForUser, { ...input, runId: runId(input.runId) });
  }

  async waitForApproval(input: { runId: string; attempt: number; workerId: string; turnId: string; pendingActions: PendingAction[]; pendingActionSelector?: string; providerSequence?: number }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.waitForApproval, { ...input, runId: runId(input.runId) });
  }

  async complete(input: { runId: string; attempt: number; workerId: string; turnId: string; output: Record<string, unknown> | null; providerSequence?: number }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.complete, { ...input, runId: runId(input.runId) });
  }

  async fail(input: { runId: string; attempt: number; workerId: string; turnId?: string; errorCode: string; errorMessage: string; providerSequence?: number }): Promise<boolean> {
    return await this.client.mutation(api.agentRuns.fail, { ...input, runId: runId(input.runId) });
  }

  async cancel(input: { runId: string; attempt: number; workerId: string; turnId?: string; providerSequence?: number }): Promise<boolean> {
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

  async getConversationTitleState(conversationId: string): Promise<{ title: string; seedMessage: string } | null> {
    const id = runId(conversationId);
    const [conversation, messages] = await Promise.all([
      this.client.query(anyApi.conversations.get, { conversationId: id }),
      this.client.query(anyApi.conversations.listMessages, { conversationId: id, limit: 1 }),
    ]);
    if (!conversation || typeof conversation !== "object" || !Array.isArray(messages)) return null;
    const title = (conversation as { title?: unknown }).title;
    const seedMessage = (messages[0] as { role?: unknown; content?: unknown } | undefined);
    if (typeof title !== "string" || seedMessage?.role !== "user" || typeof seedMessage.content !== "string") return null;
    return { title, seedMessage: seedMessage.content };
  }

  async updateConversationTitle(input: { conversationId: string; expectedTitle: string; title: string }): Promise<boolean> {
    const conversation = await this.client.mutation(anyApi.conversations.update, {
      conversationId: runId(input.conversationId),
      expectedTitle: input.expectedTitle,
      title: input.title,
    }) as unknown;
    return !!conversation;
  }

  async createAssistantDeltaStream(input: {
    conversationId: string;
    runId: string;
    attempt: number;
    workerId: string;
  }): Promise<AssistantDeltaStream> {
    const threadId = await this.client.mutation(anyApi.agentStreaming.ensureConversationThread, {
      conversationId: runId(input.conversationId),
    }) as string;
    const bridgeRefs = {
      create: {},
      addDelta: {},
      finish: {},
      abort: {},
    };
    const bridgeComponent = { streams: bridgeRefs };
    const bridgeContext = {
      runMutation: async (reference: unknown, args: unknown) => {
        const payload = args && typeof args === "object" ? args as Record<string, unknown> : {};
        const guardedPayload = {
          ...payload,
          expectedAttempt: input.attempt,
          expectedWorkerId: input.workerId,
        };
        if (reference === bridgeRefs.create) return await this.client.mutation(anyApi.agentStreaming.create, guardedPayload);
        if (reference === bridgeRefs.addDelta) return await this.client.mutation(anyApi.agentStreaming.addDelta, guardedPayload);
        if (reference === bridgeRefs.finish) return await this.client.mutation(anyApi.agentStreaming.finish, guardedPayload);
        if (reference === bridgeRefs.abort) return await this.client.mutation(anyApi.agentStreaming.abort, guardedPayload);
        throw new Error("Unknown Convex Agent stream bridge operation");
      },
    };
    const streamer = new DeltaStreamer<UIMessageChunk>(
      bridgeComponent as never,
      bridgeContext as never,
      {
        // DeltaStreamer has no trailing throttle timer. A zero throttle keeps
        // the last text/tool chunk from waiting behind a long-running tool.
        // Concurrent provider fragments are still serialized and compressed.
        throttleMs: 0,
        onAsyncAbort: async () => undefined,
        abortSignal: undefined,
        compress: compressUIMessageChunks,
      },
      {
        threadId,
        userId: input.runId,
        agentName: input.runId,
        order: Date.now(),
        stepOrder: input.attempt,
        format: "UIMessageChunk",
        provider: "trueforge",
      },
    );
    // Create the component record immediately so other devices see a durable
    // streaming row before the first provider text fragment arrives.
    await streamer.getOrCreateStreamId();
    const textPartPrefix = `assistant:${input.runId}:${input.attempt}`;
    const toolProjector = new AssistantToolStreamProjector();
    let textPartIndex = 0;
    let activeTextPartId: string | undefined;
    let ended = false;
    const addToolChunks = async (chunks: UIMessageChunk[]) => {
      if (ended || chunks.length === 0) return;
      // Close the narration segment before the first tool part. Any later text
      // starts a new segment, allowing the UI to hide transient pre-tool prose.
      if (activeTextPartId && chunks.some((chunk) => chunk.type === "tool-input-start")) {
        chunks = [{ type: "text-end", id: activeTextPartId }, ...chunks];
        activeTextPartId = undefined;
      }
      await streamer.addParts(chunks);
    };
    return {
      async addText(delta: string): Promise<void> {
        if (!delta || ended) return;
        const chunks: UIMessageChunk[] = [];
        if (!activeTextPartId) {
          activeTextPartId = `${textPartPrefix}:${textPartIndex++}`;
          chunks.push({ type: "text-start", id: activeTextPartId });
        }
        chunks.push({ type: "text-delta", id: activeTextPartId, delta });
        await streamer.addParts(chunks);
      },
      async syncToolCalls(calls): Promise<void> {
        await addToolChunks(toolProjector.sync(calls));
      },
      async completeToolCall(toolCallId): Promise<void> {
        await addToolChunks(toolProjector.complete(toolCallId));
      },
      async requestToolApproval(toolCallId, approvalId): Promise<void> {
        await addToolChunks(toolProjector.requestApproval(toolCallId, approvalId));
      },
      async finish(): Promise<void> {
        if (ended) return;
        // Do not mark the adapter ended until the component mutation succeeds:
        // Convex can commit and still report a transport error, and callers
        // must be able to retry without adding a second text-end chunk.
        if (activeTextPartId) {
          await streamer.addParts([{ type: "text-end", id: activeTextPartId }]);
          activeTextPartId = undefined;
        }
        await streamer.finish();
        ended = true;
      },
      async fail(reason: string): Promise<void> {
        if (ended) return;
        await streamer.fail(reason.slice(0, 500));
        ended = true;
      },
    };
  }

  async getAssistantMessage(conversationId: string, operationKey: string): Promise<{ content: string; tools: string[]; parts: AssistantMessagePart[] } | null> {
    const value = await this.client.query(anyApi.conversations.getMessageByOperationKey, {
      conversationId: runId(conversationId),
      operationKey,
    });
    if (!value || typeof value !== "object") return null;
    const row = value as { content?: unknown; tools?: unknown; parts?: unknown };
    const parts = Array.isArray(row.parts) ? row.parts.flatMap((rawPart): AssistantMessagePart[] => {
      if (!rawPart || typeof rawPart !== "object" || Array.isArray(rawPart)) return [];
      const part = rawPart as Record<string, unknown>;
      if (part.type !== "text" && part.type !== "tool") return [];
      return [{
        type: part.type,
        ...(typeof part.text === "string" ? { text: part.text } : {}),
        ...(typeof part.toolCallId === "string" ? { toolCallId: part.toolCallId } : {}),
        ...(typeof part.toolName === "string" ? { toolName: part.toolName } : {}),
        ...(typeof part.state === "string" ? { state: part.state } : {}),
      }];
    }) : [];
    return {
      content: typeof row.content === "string" ? row.content : "",
      tools: Array.isArray(row.tools) ? row.tools.filter((tool): tool is string => typeof tool === "string") : [],
      parts,
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
    parts?: AssistantMessagePart[];
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
      ...(input.parts !== undefined ? { parts: input.parts } : {}),
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

  async getSpecialistCompletion(input: { taskId: string; runId: string }): Promise<boolean> {
    const task = await this.client.query(anyApi.missions.taskCore, { taskId: runId(input.taskId) }) as unknown;
    if (!task || typeof task !== "object") return false;
    const row = task as { output?: unknown; activeRunId?: unknown; specialistRunId?: unknown };
    if (typeof row.output !== "string" || !row.output.trim()) return false;
    return String(row.activeRunId ?? row.specialistRunId ?? "") === input.runId;
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
    attempt: number;
    workerId: string;
    status: "completed" | "waiting_for_approval" | "waiting_for_user" | "failed" | "cancelled";
    sessionId?: string;
    turnId?: string;
    output?: unknown;
    pendingActions?: PendingAction[];
    pendingActionSelector?: string;
    errorCode?: string;
    errorMessage?: string;
    providerSequence?: number;
    operationKey: string;
  }): Promise<unknown> {
    return await this.client.mutation(anyApi.missions.finalizeSpecialist, {
      taskId: runId(input.taskId),
      runId: runId(input.runId),
      attempt: input.attempt,
      workerId: input.workerId,
      status: input.status,
      operationKey: input.operationKey,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
      ...(input.output !== undefined ? { output: input.output } : {}),
      ...(input.pendingActions !== undefined ? { pendingActions: input.pendingActions } : {}),
      ...(input.pendingActionSelector !== undefined ? { pendingActionSelector: input.pendingActionSelector } : {}),
      ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
      ...(input.errorMessage !== undefined ? { errorMessage: input.errorMessage } : {}),
      ...(input.providerSequence !== undefined ? { providerSequence: input.providerSequence } : {}),
    });
  }

  async readySuccessors(taskId: string): Promise<unknown> {
    return await this.client.query(anyApi.missions.readySuccessors, { taskId: runId(taskId) });
  }
}
