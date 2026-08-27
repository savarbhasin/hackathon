export const AGENT_RUNS_QUEUE = "agent-runs";

/** Normal run delivery. Redis never carries the run input or prompt. */
export type AgentRunDeliveryJobData = { runId: string };

/**
 * Scheduler delivery contains only identity/configuration metadata. The
 * schedule prompt is read from Convex when the fire is admitted.
 */
export type ScheduleFireJobData = {
  scheduleId: string;
  configRevision: number;
  schedulerId: string;
};

export type AgentRunJobData = AgentRunDeliveryJobData | ScheduleFireJobData;

export const SCHEDULE_FIRE_JOB_NAME = "schedule.fire";

export type AgentRunStatus =
  | "queued"
  | "enqueued"
  | "connecting"
  | "running"
  | "waiting_for_user"
  | "waiting_for_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type PendingAction = {
  type: "tool.approval_required" | "tool.response_required" | "mcp.auth_required";
  threadId?: string | null;
  selector?: string;
  name?: string;
  question?: string;
  options?: string[];
  argsPreview?: string;
  toolCalls: Array<{ id: string; sourceEventId?: string }>;
};

export type AgentRunKind = "orchestrator" | "specialist" | "schedule";

export type AgentRunRecord = {
  _id: string;
  externalId?: string;
  kind: AgentRunKind;
  status: AgentRunStatus;
  conversationId?: string;
  taskId?: string;
  scheduleId?: string;
  attempt: number;
  input: unknown;
  resumeInput?: unknown;
  pendingResume?: unknown;
  pendingActions?: PendingAction[];
  pendingActionSelector?: string;
  sessionId?: string;
  turnId?: string;
  providerSequence?: number;
  scheduleFireKey?: string;
  intendedFireAt?: number;
};

export type ScheduleConfig = {
  _id: string;
  schedulerId: string;
  configRevision: number;
  name: string;
  cronExpr: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
};

export type ScheduleTombstone = {
  _id: string;
  schedulerId: string;
  configRevision: number;
  deletedAt?: number | null;
  enabled: boolean;
};

export type ScheduleReconciliationSnapshot = {
  schedules: ScheduleConfig[];
  tombstones: ScheduleTombstone[];
};

export type AdmissionKind =
  | "accepted"
  | "already_accepted"
  | "busy"
  | "missing"
  | "selector_mismatch"
  | "invalid_state";

export type AdmissionResult<T = unknown> =
  | ({ kind: "accepted" } & T)
  | ({ kind: "already_accepted" } & T)
  | { kind: "busy"; conversationId?: string; runId?: string; status?: AgentRunStatus }
  | { kind: "missing"; conversationId?: string; runId?: string; reason?: string }
  | { kind: "selector_mismatch"; conversationId?: string; runId?: string; selector?: string }
  | { kind: "invalid_state"; conversationId?: string; runId?: string; reason?: string };

export type AssistantDeltaStream = {
  /** Append one provider text fragment to the official Convex Agent stream. */
  addText(delta: string): Promise<void>;
  /** Flush remaining deltas and mark the component stream finished. */
  finish(): Promise<void>;
  /** Abort the component stream without changing the durable run lifecycle. */
  fail(reason: string): Promise<void>;
};

export type ProviderEventCheckpoint = {
  runId: string;
  attempt: number;
  workerId: string;
  turnId: string;
  sequence: number;
  providerEventId?: string;
  providerSequence?: number;
  type: string;
  payload: Record<string, unknown>;
};

/** Persisted state adapter. Its implementation calls `api.agentRuns.*`. */
export interface AgentRunStore {
  get(runId: string): Promise<AgentRunRecord | null>;
  create(input: {
    externalId: string;
    kind: AgentRunKind;
    input: unknown;
    conversationId?: string;
    taskId?: string;
    scheduleId?: string;
    sessionId?: string;
    turnId?: string;
  }): Promise<AgentRunRecord>;
  markEnqueued(runId: string): Promise<boolean>;
  claim(input: { runId: string; workerId: string; expectedAttempt?: number }): Promise<AgentRunRecord | null>;
  checkpointSession(input: { runId: string; attempt: number; workerId: string; sessionId: string; expectedSessionId?: string }): Promise<boolean>;
  checkpointSessionTurn(input: {
    runId: string;
    attempt: number;
    workerId: string;
    sessionId?: string;
    turnId: string;
    expectedTurnId?: string;
  }): Promise<boolean>;
  checkpointProviderCursor(input: { runId: string; attempt: number; workerId: string; turnId: string; providerSequence: number }): Promise<boolean>;
  appendProviderEvent(input: ProviderEventCheckpoint): Promise<{ inserted: boolean; id: string }>;
  appendProviderEventAndCheckpoint?(input: ProviderEventCheckpoint & { providerSequence: number }): Promise<{ inserted: boolean; id: string | null; checkpointed: boolean } | null>;
  getRecoveryModelEvents?(runId: string, throughSequence: number): Promise<Array<{ sequence: number; type: string; payload: Record<string, unknown> }>>;
  waitForUser(input: { runId: string; attempt: number; workerId: string; pendingActions: PendingAction[]; pendingActionSelector?: string }): Promise<boolean>;
  waitForApproval(input: { runId: string; attempt: number; workerId: string; pendingActions: PendingAction[]; pendingActionSelector?: string }): Promise<boolean>;
  complete(input: { runId: string; attempt: number; workerId: string; turnId: string; output: Record<string, unknown> | null }): Promise<boolean>;
  fail(input: { runId: string; attempt: number; workerId: string; turnId?: string; errorCode: string; errorMessage: string }): Promise<boolean>;
  cancel(input: { runId: string; attempt: number; workerId: string; turnId?: string }): Promise<boolean>;
  queueResume(input: {
    runId: string;
    pendingAction?: PendingAction[];
    pendingActionSelector?: string;
    resumeInput: unknown;
  }): Promise<boolean>;
  acceptResume(input: {
    runId: string;
    attempt: number;
    workerId: string;
    turnId: string;
    pendingAction?: PendingAction[];
    pendingActionSelector?: string;
  }): Promise<boolean>;
  releaseForRetry(input: { runId: string; attempt: number; workerId: string; errorCode: string; errorMessage: string }): Promise<boolean>;
  getDocument(documentId: string): Promise<{ title: string; content: string } | null>;
  getConversationSession(conversationId: string): Promise<string | null>;
  createAssistantDeltaStream(input: {
    conversationId: string;
    runId: string;
    attempt: number;
    workerId: string;
  }): Promise<AssistantDeltaStream>;
  /** Existing assistant projection, used to resume a stream without replacing
   * previously persisted content when the worker is retried mid-turn. */
  getAssistantMessage?(conversationId: string, operationKey: string): Promise<{ content: string; tools: string[] } | null>;
  checkpointConversationSession(input: { conversationId: string; sessionId: string; expectedSessionId?: string }): Promise<boolean>;
  upsertAssistantMessage(input: {
    conversationId: string;
    runId: string;
    operationKey: string;
    content: string;
    tools: string[];
    status: string;
    pauseActions?: PendingAction[];
    /** Optimistic ownership guard for retry-safe worker projections. */
    attempt?: number;
    workerId?: string;
  }): Promise<unknown>;
  checkpointSpecialist(input: { taskId: string; runId: string; sessionId?: string; turnId?: string }): Promise<boolean>;
  appendTaskEvent(input: { taskId: string; type: string; payload: unknown; operationKey: string }): Promise<unknown>;
  finalizeSpecialist(input: {
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
  }): Promise<unknown>;
  readySuccessors(taskId: string): Promise<unknown>;
}

export class RecoverableRunError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RecoverableRunError";
  }
}
