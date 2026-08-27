import { isEventDelta, mergeEventDelta, TrueForge } from "@truefoundry/trueforge-sdk";
import { trueForgeBaseUrl } from "./queue/env";
import { workerLog } from "./queue/log";
import { RecoverableRunError } from "./queue/types";
import type { AgentRunRecord, AgentRunStore, PendingAction } from "./queue/types";

type Value = Record<string, unknown>;
type WorkerContext = { workerId: string; signal: AbortSignal };

function record(value: unknown): Value | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Value : null;
}

function launchInput(input: unknown): { agentName: string; items: Value[]; followup: boolean; clientMessageId?: string } {
  const value = record(input);
  const agentName = typeof value?.agentName === "string" ? value.agentName : undefined;
  const items = Array.isArray(value?.items) ? value.items : Array.isArray(value?.input) ? value.input : undefined;
  if (!agentName || !items || !items.every((item) => record(item))) {
    throw new Error("Invalid durable specialist input: expected { agentName, items: TurnInputItem[] }");
  }
  return {
    agentName,
    items: items as Value[],
    followup: value?.followup === true,
    ...(typeof value?.clientMessageId === "string" ? { clientMessageId: value.clientMessageId } : {}),
  };
}

function resumeItems(value: unknown): Value[] {
  const items = Array.isArray(value) ? value : record(value)?.items;
  if (!Array.isArray(items) || !items.every((item) => record(item))) throw new Error("Invalid pending resume input");
  return items as Value[];
}

function cursor(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function providerPayload(value: unknown): Value {
  return record(value) ?? { type: "unknown" };
}

function toolName(call: Value): string | undefined {
  const fn = record(call.function);
  const direct = typeof fn?.name === "string" ? fn.name : typeof call.name === "string" ? call.name : undefined;
  if (!direct || direct !== "call_tool") return direct;
  if (typeof fn?.arguments !== "string") return undefined;
  try {
    const args = JSON.parse(fn.arguments) as Value;
    const name = typeof args.tool_name === "string" ? args.tool_name : undefined;
    return name ? (typeof args.mcp_server === "string" ? `${args.mcp_server}.${name}` : name) : undefined;
  } catch {
    return undefined;
  }
}

function callArguments(call: Value): { parsed: Value | null; text?: string } {
  const fn = record(call.function);
  const text = typeof fn?.arguments === "string" ? fn.arguments : undefined;
  if (!text) return { parsed: null };
  try {
    const parsed = JSON.parse(text);
    return { parsed: record(parsed), text };
  } catch {
    return { parsed: null, text };
  }
}

function textFromMessages(messages: Map<string, Value>, fallback: string): string {
  const text = [...messages.values()]
    .filter((message) => message.threadId === undefined || message.threadId === "main")
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("");
  return text || fallback;
}

function namesFromMessages(messages: Map<string, Value>): string[] {
  const names = new Set<string>();
  for (const message of messages.values()) {
    for (const rawCall of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      const call = record(rawCall);
      const name = call ? toolName(call) : undefined;
      if (name) names.add(name);
    }
  }
  return [...names];
}

function stableSelector(runId: string, index: number, id: string, sourceEventId?: string): string {
  return `pause_${runId}_${index}_${sourceEventId ? `${sourceEventId}_${id}` : id}`.slice(0, 240);
}

function pendingActions(runId: string, required: unknown[], messages: Map<string, Value>): PendingAction[] {
  const result: PendingAction[] = [];
  let index = 0;
  for (const rawAction of required) {
    const action = record(rawAction);
    if (!action || !["tool.approval_required", "tool.response_required", "mcp.auth_required"].includes(String(action.type))) continue;
    for (const rawRef of Array.isArray(action.toolCalls) ? action.toolCalls : []) {
      const ref = record(rawRef);
      if (!ref || typeof ref.id !== "string") continue;
      const sourceEventId = typeof ref.sourceEventId === "string" ? ref.sourceEventId : undefined;
      const source = sourceEventId
        ? messages.get(sourceEventId)
        : [...messages.values()].find((message) => Array.isArray(message.toolCalls) && message.toolCalls.some((call) => record(call)?.id === ref.id));
      const call = source && Array.isArray(source.toolCalls) ? source.toolCalls.map(record).find((item) => item?.id === ref.id) : undefined;
      const args = call ? callArguments(call) : { parsed: null };
      result.push({
        type: action.type as PendingAction["type"],
        selector: stableSelector(runId, index++, ref.id, sourceEventId),
        threadId: typeof action.threadId === "string" || action.threadId === null ? action.threadId : undefined,
        toolCalls: [{ id: ref.id, ...(sourceEventId ? { sourceEventId } : {}) }],
        ...(call && toolName(call) ? { name: toolName(call) } : {}),
        ...(typeof args.parsed?.question === "string" ? { question: args.parsed.question } : {}),
        ...(Array.isArray(args.parsed?.options) && args.parsed.options.every((option) => typeof option === "string") ? { options: args.parsed.options as string[] } : {}),
        ...(args.text ? { argsPreview: args.text.slice(0, 300) } : {}),
      });
    }
  }
  return result;
}

function retryable(error: unknown): RecoverableRunError | null {
  if (error instanceof RecoverableRunError) return error;
  const value = error as { message?: unknown; code?: unknown; name?: unknown; statusCode?: unknown };
  const message = typeof value.message === "string" ? value.message : "";
  const status = typeof value.statusCode === "number" ? value.statusCode : 0;
  if (value.name === "AbortError" || status === 408 || status === 429 || status >= 500 || /\b(408|429|5\d\d)\b|fetch failed|econn|enotfound|network|timeout|temporar|unavailable|disconnect|socket|connection reset|aborted/i.test(message)) {
    return new RecoverableRunError(typeof value.code === "string" ? value.code : "specialist_infrastructure", message || "Recoverable specialist infrastructure failure");
  }
  return null;
}

async function checkpoint(ok: boolean, code: string): Promise<void> {
  if (!ok) throw new RecoverableRunError(code, `Specialist checkpoint was rejected: ${code}`);
}

async function semantic(store: AgentRunStore, taskId: string, runId: string, type: string, payload: Value, suffix: string): Promise<void> {
  await store.appendTaskEvent({ taskId, type, payload, operationKey: suffix.startsWith("admission:") ? suffix : `worker:${runId}:${suffix}` });
}

/** Executes one claimed specialist run and projects it to the durable task model. */
export async function processDurableSpecialistRun(store: AgentRunStore, run: AgentRunRecord, context: WorkerContext): Promise<void> {
  if (!run.taskId) throw new Error("Specialist run is missing task linkage");
  const taskId = run.taskId;
  const attempt = run.attempt;
  const client = new TrueForge({ baseUrl: trueForgeBaseUrl(), timeoutInSeconds: 60, maxRetries: 0 });
  let sessionId = run.sessionId;
  let turnId = run.turnId;
  let fallbackText = "";
  let tools: string[] = [];
  const messages = new Map<string, Value>();
  let followup = false;
  let clientMessageId: string | undefined;

  try {
    const input = launchInput(run.input);
    followup = input.followup;
    clientMessageId = input.clientMessageId;
    const hasResume = run.resumeInput !== undefined && run.resumeInput !== null;
    if (!sessionId) {
      const { data: session } = await client.sessions.create({ agent: { name: input.agentName } });
      sessionId = session.id;
      await checkpoint(await store.checkpointSession({ runId: run._id, attempt, workerId: context.workerId, sessionId }), "checkpoint_session");
      await checkpoint(await store.checkpointSpecialist({ taskId, runId: run._id, sessionId }), "checkpoint_task_session");
    } else {
      let missing = false;
      try {
        await client.sessions.get(sessionId);
      } catch (error) {
        const failure = retryable(error);
        if (failure) throw failure;
        missing = true;
      }
      if (missing) {
        if (hasResume) throw new Error("Cannot resume specialist turn after its TrueForge session was lost");
        const previousSession = sessionId;
        const { data: session } = await client.sessions.create({ agent: { name: input.agentName } });
        sessionId = session.id;
        await checkpoint(await store.checkpointSession({ runId: run._id, attempt, workerId: context.workerId, sessionId, expectedSessionId: previousSession }), "checkpoint_recreated_session");
        await checkpoint(await store.checkpointSpecialist({ taskId, runId: run._id, sessionId }), "checkpoint_recreated_task_session");
        turnId = undefined;
      } else {
        await checkpoint(await store.checkpointSpecialist({ taskId, runId: run._id, sessionId }), "checkpoint_existing_task_session");
      }
    }
    if (!sessionId) throw new Error("Specialist session was not established");

    if (hasResume) {
      if (!run.turnId || !run.pendingActions) throw new Error("Resume specialist run is missing paused turn or actions");
      const turns = await client.sessions.listTurns(sessionId, { limit: 25 });
      const newest = turns.data[0];
      const ids: string[] = [];
      for await (const turn of turns) ids.push(turn.id);
      const pausedIndex = ids.indexOf(run.turnId);
      if (pausedIndex > 0 && newest) turnId = newest.id;
      else {
        const { data: turn } = await client.sessions.createTurn(sessionId, { input: resumeItems(run.resumeInput) as never });
        turnId = turn.id;
      }
      await checkpoint(await store.checkpointSessionTurn({ runId: run._id, attempt, workerId: context.workerId, sessionId, turnId, expectedTurnId: run.turnId }), "checkpoint_resume_turn");
      await checkpoint(await store.checkpointSpecialist({ taskId, runId: run._id, sessionId, turnId }), "checkpoint_resume_task_turn");
      await checkpoint(await store.acceptResume({ runId: run._id, attempt, workerId: context.workerId, turnId, pendingAction: run.pendingActions, pendingActionSelector: run.pendingActionSelector }), "accept_resume");
    } else if (!turnId) {
      const turns = await client.sessions.listTurns(sessionId, { limit: 25 });
      const newest = turns.data[0];
      if (newest && record(newest.state)?.status === "running") turnId = newest.id;
      else {
        const { data: turn } = await client.sessions.createTurn(sessionId, {
          input: input.items as never,
          ...(!followup ? { previousTurnId: "none" as never } : {}),
        });
        turnId = turn.id;
      }
      await checkpoint(await store.checkpointSessionTurn({ runId: run._id, attempt, workerId: context.workerId, sessionId, turnId }), "checkpoint_new_turn");
      await checkpoint(await store.checkpointSpecialist({ taskId, runId: run._id, sessionId, turnId }), "checkpoint_task_turn");
      await semantic(store, taskId, run._id, "activity.started", { runId: run._id, sessionId, turnId }, `admission:${run._id}`);
    }
    if (!turnId) throw new Error("Specialist turn was not established");

    const stream = await client.sessions.subscribeToTurn(sessionId, turnId, hasResume ? {} : (run.providerSequence === undefined ? {} : { afterSequenceNumber: run.providerSequence }), { abortSignal: context.signal });
    let fallbackSequence = (run.providerSequence ?? 0) + 1;
    for await (const metadata of stream.withMetadata()) {
      if (context.signal.aborted) throw new RecoverableRunError("worker_shutdown", "Worker shutdown interrupted specialist subscription");
      const event = providerPayload(metadata.data);
      const type = typeof event.type === "string" ? event.type : "unknown";
      const providerSequence = cursor(metadata.id);
      const sequence = providerSequence ?? fallbackSequence++;
      const providerEventId = typeof event.id === "string" && !isEventDelta(metadata.data as never) ? event.id : undefined;
      if (type === "model.message" && typeof event.id === "string") messages.set(event.id, event);
      if (isEventDelta(metadata.data as never)) {
        if (typeof event.id === "string") {
          const base = messages.get(event.id);
          if (base) mergeEventDelta(base as never, metadata.data as never);
        }
        if (event.threadId === "main" && typeof event.content === "string") fallbackText += event.content;
      }
      await store.appendProviderEvent({ runId: run._id, attempt, workerId: context.workerId, turnId, sequence, providerEventId, providerSequence: providerSequence ?? undefined, type, payload: event });
      if (providerSequence !== null) await checkpoint(await store.checkpointProviderCursor({ runId: run._id, attempt, workerId: context.workerId, turnId, providerSequence }), "checkpoint_cursor");

      if (type === "model.message" || type.startsWith("tool.")) {
        tools = namesFromMessages(messages);
        const toolInfo = record(event.toolInfo);
        const directName = typeof event.name === "string"
          ? event.name
          : typeof event.toolName === "string"
            ? event.toolName
            : typeof toolInfo?.name === "string" ? toolInfo.name : undefined;
        if (directName || tools.length > 0) {
          await semantic(store, taskId, run._id, "activity.tool", { name: directName ?? tools[tools.length - 1], runId: run._id }, `tool:${providerEventId ?? sequence}`);
        }
      }
      if (type !== "turn.done") continue;

      const state = record(event.state) ?? {};
      const status = typeof state.status === "string" ? state.status : "error";
      const output = record(state.output);
      const content = typeof output?.content === "string" ? output.content : textFromMessages(messages, fallbackText);
      tools = namesFromMessages(messages);
      if (status === "done") {
        const actions = pendingActions(run._id, Array.isArray(state.requiredActions) ? state.requiredActions : [], messages);
        if (followup) {
          await semantic(store, taskId, run._id, "chat.assistant", {
            content,
            tools,
            status: actions.length > 0 ? "waiting" : "completed",
            ...(clientMessageId ? { clientMessageId } : {}),
          }, `chat-assistant:${clientMessageId ?? run._id}`);
        }
        if (actions.length > 0) {
          const waitingStatus = actions.some((action) => action.type === "tool.approval_required") ? "waiting_for_approval" : "waiting_for_user";
          const selector = actions.length === 1 ? actions[0].selector : undefined;
          const finalized = await store.finalizeSpecialist({ taskId, runId: run._id, status: waitingStatus, sessionId, turnId, pendingActions: actions, pendingActionSelector: selector, operationKey: `worker:${run._id}:pause:${selector ?? "multiple"}` });
          if (!finalized || !["created", "idempotent"].includes(String((finalized as Value).kind))) return;
          workerLog("run.specialist_paused", { runId: run._id, taskId, turnId, actionCount: actions.length });
          return;
        }
        const finalized = await store.finalizeSpecialist({ taskId, runId: run._id, status: "completed", sessionId, turnId, output: content.slice(0, 8_000), operationKey: `worker:${run._id}:completed` });
        if (!finalized || !["created", "idempotent"].includes(String((finalized as Value).kind))) return;
        const ready = await store.readySuccessors(taskId);
        if (Array.isArray(ready)) {
          const { durableDispatchTask } = await import("./durable-task-engine");
          for (const successor of ready) {
            const value = record(successor);
            const task = record(value?.task);
            const successorId = typeof value?._id === "string" ? value._id : typeof value?.taskId === "string" ? value.taskId : typeof task?._id === "string" ? task._id : undefined;
            if (successorId) await durableDispatchTask(successorId);
          }
        }
        return;
      }
      if (status === "cancelled") {
        await store.finalizeSpecialist({ taskId, runId: run._id, status: "cancelled", sessionId, turnId, errorMessage: typeof state.reason === "string" ? state.reason : "cancelled", operationKey: `worker:${run._id}:cancelled` });
        return;
      }
      const message = typeof state.message === "string" ? state.message : "TrueForge turn returned an error state";
      if (retryable(new Error(message))) throw new RecoverableRunError("trueforge_terminal_transient", message);
      await store.finalizeSpecialist({ taskId, runId: run._id, status: "failed", sessionId, turnId, errorCode: "trueforge_terminal", errorMessage: message, operationKey: `worker:${run._id}:failed` });
      return;
    }
    throw new RecoverableRunError("trueforge_stream_ended", "Provider stream ended without turn.done");
  } catch (error) {
    const failure = retryable(error);
    const message = error instanceof Error ? error.message : "Unknown specialist worker failure";
    if (failure) {
      await store.releaseForRetry({ runId: run._id, attempt, workerId: context.workerId, errorCode: failure.code, errorMessage: failure.message });
      throw failure;
    }
    if (followup) {
      await semantic(store, taskId, run._id, "chat.assistant", {
        content: `The chat turn failed: ${message}`,
        status: "failed",
        ...(clientMessageId ? { clientMessageId } : {}),
      }, `chat-assistant:${clientMessageId ?? run._id}`);
    }
    await store.finalizeSpecialist({ taskId, runId: run._id, status: "failed", sessionId, turnId, errorCode: "worker_permanent", errorMessage: message, operationKey: `worker:${run._id}:failed` });
  }
}
