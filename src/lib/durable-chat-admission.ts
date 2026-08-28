import { randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import { convexUrl } from "./queue/env";
import { enqueueAdmittedResume, enqueueAdmittedRun, type EnqueueResult } from "./queue/producer";
import {
  buildProviderResumeInput,
  parseResumeSelections,
  type PersistedPauseAction,
  type ResumeSelection,
} from "./orchestrator-pause";
import { fallbackConversationTitle } from "./conversation-title";

const convexFunctions = api as unknown as Record<string, Record<string, any>>;

const activeStatuses = new Set([
  "queued",
  "enqueued",
  "connecting",
  "running",
  "waiting_for_user",
  "waiting_for_approval",
]);
const waitingStatuses = new Set(["waiting_for_user", "waiting_for_approval"]);

let client: ConvexHttpClient | undefined;
function convex(): ConvexHttpClient {
  return (client ??= new ConvexHttpClient(convexUrl(), { logger: false }));
}

export type DurableQueueOutcome = EnqueueResult | { kind: "error"; code: "enqueue_failed" };

export type DurableAdmissionResponse = {
  kind: string;
  idempotent?: boolean;
  conversation?: Record<string, unknown> | null;
  message?: Record<string, unknown> | null;
  run?: Record<string, unknown> | null;
  conversationId?: string;
  runId?: string;
  status?: string;
  reason?: string;
  selector?: string;
  queue?: DurableQueueOutcome;
};

function functionRef(moduleName: string, name: string): any {
  const moduleFunctions = convexFunctions[moduleName];
  if (!moduleFunctions?.[name]) throw new Error(`Convex function unavailable: ${moduleName}.${name}`);
  return moduleFunctions[name];
}

function asId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim();
  return result && result.length <= 512 ? result : undefined;
}

function asRunId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return asId((value as Record<string, unknown>)._id);
}

function asConversationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return asId((value as Record<string, unknown>)._id);
}

const titleFor = fallbackConversationTitle;

function keyFrom(value: unknown, header: string | null | undefined): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  const supplied = candidate || (header?.trim() ?? "");
  return supplied && supplied.length <= 256 ? supplied : randomUUID();
}

function operationKeys(requestKey: string, kind: "start" | "resume") {
  const prefix = `chat:${kind}:${requestKey}`;
  return {
    externalId: `${prefix}:run`,
    conversationOperationKey: `${prefix}:conversation`,
    messageOperationKey: `${prefix}:message`,
  };
}

function idFromResult(result: DurableAdmissionResponse, field: "conversation" | "run"): string | undefined {
  return field === "conversation" ? result.conversationId ?? asConversationId(result.conversation) : result.runId ?? asRunId(result.run);
}

function baseResponse(result: DurableAdmissionResponse, queue: DurableQueueOutcome): DurableAdmissionResponse {
  const conversationId = idFromResult(result, "conversation");
  const runId = idFromResult(result, "run");
  return {
    ...result,
    ...(conversationId ? { conversationId } : {}),
    ...(runId ? { runId } : {}),
    ...(result.run && typeof result.run.status === "string" ? { status: result.run.status } : {}),
    queue,
  };
}

async function enqueueStart(result: DurableAdmissionResponse): Promise<DurableAdmissionResponse> {
  const runId = idFromResult(result, "run");
  if (!runId) return { ...result, queue: { kind: "error", code: "enqueue_failed" } };
  try {
    return baseResponse(result, await enqueueAdmittedRun(runId));
  } catch {
    return baseResponse(result, { kind: "error", code: "enqueue_failed" });
  }
}

async function enqueueResume(result: DurableAdmissionResponse): Promise<DurableAdmissionResponse> {
  const runId = idFromResult(result, "run");
  if (!runId) return { ...result, queue: { kind: "error", code: "enqueue_failed" } };
  try {
    return baseResponse(result, await enqueueAdmittedResume(runId));
  } catch {
    return baseResponse(result, { kind: "error", code: "enqueue_failed" });
  }
}

export async function admitDurableStart(input: {
  message: string;
  conversationId?: string;
  documentIds?: string[];
  requestKey?: unknown;
  idempotencyHeader?: string | null;
}): Promise<DurableAdmissionResponse> {
  const requestKey = keyFrom(input.requestKey, input.idempotencyHeader);
  const keys = operationKeys(requestKey, "start");
  const response = await convex().mutation(functionRef("conversations", "admitStart"), {
    externalId: keys.externalId,
    message: input.message,
    title: titleFor(input.message),
    input: {
      agentName: "orchestrator",
      spec: "orchestrator",
      documentIds: input.documentIds ?? [],
      items: [{ type: "user.message", content: input.message }],
    },
    ...(input.conversationId ? { conversationId: input.conversationId as never } : {}),
    conversationOperationKey: keys.conversationOperationKey,
    operationKey: keys.externalId,
    messageOperationKey: keys.messageOperationKey,
  }) as DurableAdmissionResponse;
  if (response.kind !== "accepted" && response.kind !== "already_accepted") return response;
  return enqueueStart(response);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Convert the worker's compact pending-action shape to pause utility input. */
function persistedActions(run: Record<string, unknown>, selectedSelector?: string): PersistedPauseAction[] {
  const pending = run.pendingActions;
  if (!Array.isArray(pending)) return [];
  const explicitSelector = stringValue(run.pendingActionSelector);
  const result: PersistedPauseAction[] = [];
  for (const rawAction of pending) {
    const action = record(rawAction);
    if (!action || typeof action.type !== "string") continue;
    const threadId = typeof action.threadId === "string" || action.threadId === null ? action.threadId : undefined;
    const actionSelector = stringValue(action.selector);
    const calls = Array.isArray(action.toolCalls) ? action.toolCalls : [];
    const selectedCalls = selectedSelector && actionSelector === selectedSelector && calls.length > 1
      ? calls.filter((rawCall) => {
        const call = record(rawCall);
        return stringValue(call?.id) === selectedSelector || stringValue(call?.sourceEventId) === selectedSelector;
      })
      : calls;
    if (selectedSelector && actionSelector === selectedSelector && calls.length > 1 && selectedCalls.length === 0) continue;
    for (const rawCall of selectedCalls) {
      const call = record(rawCall);
      const toolCallId = stringValue(call?.id) ?? stringValue(action.toolCallId);
      if (!toolCallId) continue;
      const sourceEventId = stringValue(call?.sourceEventId);
      // Rich per-action selectors are authoritative. The run-level selector is
      // only valid for an unlabelled single action or call.
      const callSelector = explicitSelector && (
        explicitSelector === toolCallId ||
        explicitSelector === sourceEventId ||
        (pending.length === 1 && calls.length === 1)
      )
        ? explicitSelector
        : toolCallId;
      const selector = actionSelector ?? callSelector;
      if (selectedSelector && selector !== selectedSelector) continue;
      result.push({ selector, type: action.type, toolCallId, threadId });
    }
  }
  // A future worker may persist the richer pause shape directly without a
  // nested toolCalls array. Preserve its action selector before fallbacks.
  if (result.length === 0 && Array.isArray(pending)) {
    for (const value of pending) {
      const action = record(value);
      const actionSelector = stringValue(action?.selector);
      const toolCallId = stringValue(action?.toolCallId);
      if (!toolCallId || typeof action?.type !== "string") continue;
      const selector = actionSelector ?? (explicitSelector ?? toolCallId);
      if (selectedSelector && selector !== selectedSelector) continue;
      result.push({ selector, toolCallId, type: action.type, threadId: typeof action.threadId === "string" || action.threadId === null ? action.threadId : undefined });
    }
  }
  return result;
}

function answerContent(selection: ResumeSelection): string {
  if (selection.decision === "allow") return "Approved";
  if (selection.decision === "deny") return "Denied";
  return selection.content?.trim() ?? "Responded to paused action";
}

export async function admitDurableResume(input: {
  conversationId: string;
  answers: unknown;
  requestKey?: unknown;
  idempotencyHeader?: string | null;
}): Promise<DurableAdmissionResponse> {
  const selections = parseResumeSelections(input.answers);
  if (selections.length !== 1) {
    return { kind: "invalid_resume_payload", reason: "Durable resume accepts exactly one pause selection." };
  }
  const active = await convex().query(functionRef("agentRuns", "activeForConversation"), { conversationId: input.conversationId as never }) as Record<string, unknown> | null;
  if (!active || !waitingStatuses.has(String(active.status))) {
    return { kind: "missing", conversationId: input.conversationId, reason: "no_waiting_orchestrator_run" };
  }
  const selection = selections[0];
  const actions = persistedActions(active, selection.selector);
  const resumeInput = buildProviderResumeInput(actions, selections);
  const requestKey = keyFrom(input.requestKey, input.idempotencyHeader);
  const keys = operationKeys(requestKey, "resume");
  const response = await convex().mutation(functionRef("conversations", "admitResume"), {
    conversationId: input.conversationId as never,
    selector: selection.selector,
    resumeInput,
    content: answerContent(selection),
    operationKey: keys.externalId,
    messageOperationKey: keys.messageOperationKey,
  }) as DurableAdmissionResponse;
  if (response.kind !== "accepted" && response.kind !== "already_accepted") return response;
  return enqueueResume(response);
}

export async function listDurableConversations(): Promise<unknown[]> {
  const rows = await convex().query(functionRef("conversations", "list"), { limit: 200 }) as unknown;
  if (!Array.isArray(rows)) return [];
  return await Promise.all(rows.map(async (value) => {
    const conversation = record(value);
    if (!conversation) return value;
    const id = asId(conversation._id);
    if (!id) return value;
    const [detail, active, latest] = await Promise.all([
      convex().query(functionRef("conversations", "getDetail"), { conversationId: id as never, messageLimit: 2000 }),
      convex().query(functionRef("agentRuns", "activeForConversation"), { conversationId: id as never }),
      convex().query(functionRef("agentRuns", "latestForConversation"), { conversationId: id as never }),
    ]);
    const messages = record(detail)?.messages;
    return {
      id,
      title: conversation.title,
      createdAt: new Date(Number(conversation.createdAt)).toISOString(),
      updatedAt: new Date(Number(conversation.updatedAt)).toISOString(),
      _count: { messages: Array.isArray(messages) ? messages.length : 0 },
      runStatus: record(active)?.status ?? record(latest)?.status ?? null,
      activeRun: active ?? null,
    };
  }));
}

function serializeMessage(value: unknown): Record<string, unknown> | null {
  const message = record(value);
  if (!message) return null;
  const id = asId(message._id) ?? "";
  const tools = typeof message.tools === "string" ? message.tools : JSON.stringify(message.tools ?? []);
  const pauseActions = message.pauseActions == null
    ? null
    : typeof message.pauseActions === "string" ? message.pauseActions : JSON.stringify(message.pauseActions);
  return {
    id,
    role: message.role,
    content: message.content,
    tools,
    status: message.status ?? null,
    pauseActions,
    createdAt: new Date(Number(message.createdAt)).toISOString(),
  };
}

export async function getDurableConversation(id: string): Promise<Record<string, unknown> | null> {
  const [detail, active, latest] = await Promise.all([
    convex().query(functionRef("conversations", "getDetail"), { conversationId: id as never, messageLimit: 2000 }),
    convex().query(functionRef("agentRuns", "activeForConversation"), { conversationId: id as never }),
    convex().query(functionRef("agentRuns", "latestForConversation"), { conversationId: id as never }),
  ]);
  const conversation = record(detail);
  if (!conversation) return null;
  return {
    id: asId(conversation._id) ?? id,
    title: conversation.title,
    createdAt: new Date(Number(conversation.createdAt)).toISOString(),
    updatedAt: new Date(Number(conversation.updatedAt)).toISOString(),
    messages: Array.isArray(conversation.messages) ? conversation.messages.map(serializeMessage).filter(Boolean) : [],
    runStatus: record(active)?.status ?? record(latest)?.status ?? null,
    activeRun: active ?? null,
  };
}

export async function deleteDurableConversation(id: string): Promise<{ kind: "deleted" | "missing" | "active"; run?: Record<string, unknown> | null }> {
  const active = await convex().query(functionRef("agentRuns", "activeForConversation"), { conversationId: id as never }) as Record<string, unknown> | null;
  if (activeStatuses.has(String(active?.status))) return { kind: "active", run: active };
  const deleted = await convex().mutation(functionRef("conversations", "remove"), { conversationId: id as never });
  return deleted ? { kind: "deleted" } : { kind: "missing" };
}
