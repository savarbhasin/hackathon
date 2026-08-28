import { isEventDelta, mergeEventDelta, TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_SPEC } from "./fleet";
import { fallbackConversationTitle, generateConversationTitle } from "./conversation-title";
import type { AgentRunRecord, AgentRunStore, AssistantDeltaStream, AssistantToolCall, PendingAction } from "./queue/types";
import { RecoverableRunError } from "./queue/types";
import { trueForgeBaseUrl } from "./queue/env";
import { workerLog } from "./queue/log";

export type DurableOrchestratorInput = {
  message: string;
  documentIds?: string[];
  items?: Array<Record<string, unknown>>;
};

type RecordValue = Record<string, unknown>;
type WorkerContext = { workerId: string; signal: AbortSignal };

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

export function parseDurableOrchestratorInput(value: unknown): DurableOrchestratorInput {
  const input = record(value);
  const message = typeof input?.message === "string" ? input.message : "";
  const items = Array.isArray(input?.items) && input.items.every((item) => record(item))
    ? input.items as Array<Record<string, unknown>>
    : undefined;
  const documentIds = Array.isArray(input?.documentIds)
    ? input.documentIds.filter((id): id is string => typeof id === "string" && id.length > 0).slice(0, 8)
    : [];
  if (!message.trim() && (!items || items.length === 0)) {
    throw new Error("Invalid durable orchestrator input: expected a message or turn input items");
  }
  return { message, documentIds, items };
}

async function orchestratorSpec(): Promise<TrueForgeApi.AgentSpec> {
  const { agentRosterBlock } = await import("./agents");
  const roster = await agentRosterBlock();
  return roster ? { ...ORCHESTRATOR_SPEC, instructions: `${ORCHESTRATOR_INSTRUCTIONS}\n\n${roster}` } : ORCHESTRATOR_SPEC;
}

async function attachedDocumentContext(store: AgentRunStore, ids: string[]): Promise<string> {
  const unique = [...new Set(ids)].slice(0, 5);
  if (unique.length === 0) return "";
  const documents = await Promise.all(unique.map((id) => store.getDocument(id).catch(() => null)));
  let used = 0;
  const parts: string[] = [];
  for (const document of documents) {
    if (!document) continue;
    const remaining = 48_000 - used;
    if (remaining <= 0) break;
    const content = document.content.slice(0, Math.min(12_000, remaining));
    used += content.length;
    parts.push(`Document: ${document.title}\n${content}`);
  }
  return parts.length > 0
    ? `\n\nThe user attached these saved documents as working context. Use them when relevant.\n\n${parts.join("\n\n---\n\n")}`
    : "";
}

function turnItems(input: DurableOrchestratorInput, context: string): Array<Record<string, unknown>> {
  if (input.items && input.items.length > 0) {
    let addedContext = false;
    const items = input.items.map((item) => {
      if (!addedContext && item.type === "user.message" && typeof item.content === "string") {
        addedContext = true;
        return { ...item, content: `${item.content}${context}` };
      }
      return item;
    });
    if (addedContext) return items;
    return [...items, { type: "user.message", content: `${input.message}${context}` }];
  }
  return [{ type: "user.message", content: `${input.message}${context}` }];
}

function numberCursor(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function eventPayload(event: unknown): RecordValue {
  return record(event) ?? { type: "unknown" };
}

function toolName(call: RecordValue): string | undefined {
  // TrueForge attaches the resolved tool metadata before the wrapper's JSON
  // arguments have necessarily finished streaming. Prefer it so the UI can
  // display the real MCP action immediately instead of waiting for call_tool's
  // complete argument object.
  const info = record(call.toolInfo);
  const resolvedName = typeof info?.name === "string" ? info.name : undefined;
  if (resolvedName) {
    return info?.type === "mcp" && typeof info?.serverName === "string"
      ? `${info.serverName}.${resolvedName}`
      : resolvedName;
  }

  const fn = record(call.function);
  const name = typeof fn?.name === "string" ? fn.name : undefined;
  if (!name || name !== "call_tool") return name;
  const args = typeof fn?.arguments === "string" ? fn.arguments : "";
  try {
    const parsed = JSON.parse(args) as RecordValue;
    const nested = typeof parsed.tool_name === "string" ? parsed.tool_name : undefined;
    return nested ? (typeof parsed.mcp_server === "string" ? `${parsed.mcp_server}.${nested}` : nested) : undefined;
  } catch {
    return undefined;
  }
}

function callArgs(call: RecordValue): RecordValue | null {
  const fn = record(call.function);
  if (typeof fn?.arguments !== "string") return null;
  try {
    const value = JSON.parse(fn.arguments);
    return record(value);
  } catch {
    return null;
  }
}

function normalizedText(messages: Map<string, RecordValue>, fallback: string): string {
  const text = [...messages.values()]
    .filter((message) => message.threadId === undefined || message.threadId === "main")
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("");
  return text || fallback;
}

/**
 * Tool-calling models often narrate an action ("I'll check…") in the same
 * message that requests the tool. Keep that text live until the tool appears,
 * but exclude it from the durable answer once a later model message responds.
 */
export function textAfterLastToolCall(messages: Map<string, RecordValue>, fallback: string): string {
  const main = [...messages.values()]
    .filter((message) => message.threadId === undefined || message.threadId === "main");
  let lastToolCall = -1;
  for (let index = 0; index < main.length; index += 1) {
    const toolCalls = main[index].toolCalls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) lastToolCall = index;
  }
  if (lastToolCall < 0) return normalizedText(messages, fallback);
  return main
    .slice(lastToolCall + 1)
    .map((message) => typeof message.content === "string" ? message.content : "")
    .join("");
}

export function toolNamesFromMessages(messages: Map<string, RecordValue>): string[] {
  const names: string[] = [];
  for (const message of messages.values()) {
    for (const call of (Array.isArray(message.toolCalls) ? message.toolCalls : [])) {
      const value = record(call);
      const name = value ? toolName(value) : undefined;
      if (name) names.push(name);
    }
  }
  return names;
}

/** Cumulative tool-call snapshots consumed by the Convex UIMessageChunk adapter. */
export function streamingToolCalls(messages: Map<string, RecordValue>): AssistantToolCall[] {
  const calls: AssistantToolCall[] = [];
  for (const message of messages.values()) {
    for (const rawCall of (Array.isArray(message.toolCalls) ? message.toolCalls : [])) {
      const call = record(rawCall);
      if (!call || typeof call.id !== "string") continue;
      const name = toolName(call);
      const fn = record(call.function);
      if (!name || typeof fn?.arguments !== "string") continue;
      let input: unknown;
      let inputAvailable = false;
      try {
        input = JSON.parse(fn.arguments);
        inputAvailable = true;
      } catch {
        // Arguments are expected to be incomplete while model deltas arrive.
      }
      calls.push({
        toolCallId: call.id,
        toolName: name,
        inputText: fn.arguments,
        inputAvailable,
        ...(inputAvailable ? { input } : {}),
      });
    }
  }
  return calls;
}

function stableSelector(runId: string, actionIndex: number, toolCallId: string, sourceEventId?: string): string {
  const suffix = sourceEventId ? `${sourceEventId}_${toolCallId}` : toolCallId;
  return `pause_${runId}_${actionIndex}_${suffix}`.slice(0, 240);
}

function enrichPendingActions(runId: string, required: unknown[], messages: Map<string, RecordValue>): PendingAction[] {
  const result: PendingAction[] = [];
  let index = 0;
  for (const value of required) {
    const action = record(value);
    if (!action || typeof action.type !== "string") continue;
    if (action.type !== "tool.approval_required" && action.type !== "tool.response_required" && action.type !== "mcp.auth_required") continue;
    const refs = Array.isArray(action.toolCalls) ? action.toolCalls : [];
    for (const refValue of refs) {
      const ref = record(refValue);
      if (!ref || typeof ref.id !== "string") continue;
      const sourceEventId = typeof ref.sourceEventId === "string" ? ref.sourceEventId : undefined;
      const message = sourceEventId ? messages.get(sourceEventId) : [...messages.values()].find((candidate) =>
        Array.isArray(candidate.toolCalls) && candidate.toolCalls.some((call) => record(call)?.id === ref.id));
      const call = message && Array.isArray(message.toolCalls)
        ? message.toolCalls.map(record).find((candidate) => candidate?.id === ref.id)
        : undefined;
      const args = call ? callArgs(call) : null;
      const fn = call ? record(call.function) : null;
      const argsText = typeof fn?.arguments === "string" ? fn.arguments : undefined;
      result.push({
        type: action.type,
        selector: stableSelector(runId, index++, ref.id, sourceEventId),
        threadId: typeof action.threadId === "string" || action.threadId === null ? action.threadId : undefined,
        toolCalls: [{ id: ref.id, ...(sourceEventId ? { sourceEventId } : {}) }],
        ...(call && toolName(call) ? { name: toolName(call) } : {}),
        ...(typeof args?.question === "string" ? { question: args.question } : {}),
        ...(Array.isArray(args?.options) && args.options.every((option) => typeof option === "string") ? { options: args.options as string[] } : {}),
        ...(argsText ? { argsPreview: argsText.slice(0, 300) } : {}),
      });
    }
  }
  return result;
}

function recoverableTerminal(message: string): boolean {
  const normalized = message.toLowerCase();
  if (["no credits", "unauthorized", "forbidden", "invalid"].some((part) => normalized.includes(part))) return false;
  return /\b(408|429|5\d\d)\b/.test(normalized) || /timeout|temporar|unavailable/.test(normalized);
}

function recoverableError(error: unknown): RecoverableRunError | null {
  if (error instanceof RecoverableRunError) return error;
  const value = error as { message?: unknown; code?: unknown; name?: unknown; statusCode?: unknown };
  const message = typeof value.message === "string" ? value.message : "";
  const status = typeof value.statusCode === "number" ? value.statusCode : 0;
  if (value.name === "AbortError" || status === 408 || status === 429 || status >= 500 || /fetch failed|econn|enotfound|network|timeout|temporar|unavailable|disconnect|socket|connection reset|aborted/i.test(message)) {
    return new RecoverableRunError(typeof value.code === "string" ? value.code : "trueforge_stream", message || "Recoverable TrueForge failure");
  }
  return null;
}

async function requireCheckpoint(ok: boolean, code: string): Promise<void> {
  if (!ok) throw new RecoverableRunError(code, `Durable checkpoint was rejected: ${code}`);
}

function completionTokenStatus(metrics: RecordValue | undefined): string {
  const outputTokens = metrics?.totalOutputTokens;
  const totalTokens = metrics?.totalTokens;
  const tokens = typeof outputTokens === "number" && Number.isFinite(outputTokens)
    ? outputTokens
    : typeof totalTokens === "number" && Number.isFinite(totalTokens) ? totalTokens : 0;
  return tokens > 0 ? `${Math.round(tokens).toLocaleString()} tokens` : "";
}

type ProjectionOwnership = { attempt: number; workerId: string };

async function maybeGenerateConversationTitle(
  store: AgentRunStore,
  client: TrueForge,
  conversationId: string | undefined,
  firstMessage: string,
): Promise<void> {
  if (!conversationId || !firstMessage.trim()) return;
  const currentTitle = await store.getConversationTitle(conversationId);
  // Admission seeds new conversations with the first-message fallback. Once a
  // model title exists, later turns must never rename the conversation.
  if (currentTitle !== fallbackConversationTitle(firstMessage)) return;
  const generated = await generateConversationTitle(client, firstMessage);
  if (generated && generated !== currentTitle) {
    await store.updateConversationTitle({ conversationId, title: generated });
  }
}

async function project(
  store: AgentRunStore,
  run: AgentRunRecord,
  content: string,
  tools: string[],
  status: string,
  pauseActions?: PendingAction[],
  ownership?: ProjectionOwnership,
): Promise<void> {
  if (!run.conversationId) return;
  await store.upsertAssistantMessage({
    conversationId: run.conversationId,
    runId: run._id,
    operationKey: `assistant:${run._id}`,
    content: content.slice(0, 100_000),
    tools,
    status,
    ...(pauseActions ? { pauseActions } : {}),
    ...(ownership ?? {}),
  });
}

/**
 * Merges either a cumulative or fragmentary provider text candidate against a
 * stable persisted prefix. A retry can begin with only a suffix (and some
 * providers emit cumulative suffixes), so appending every candidate directly
 * would produce e.g. `Hello w world`.
 */
export function mergeStreamingCandidate(baseline: string, previousDelta: string, candidate: string): string {
  if (!candidate) return previousDelta;

  // A cursorless retry replays cumulative text from the beginning. Ignore
  // candidates that have not reached the persisted prefix yet, then remove
  // either the full prefix or the replay overlap at its boundary.
  if (baseline.startsWith(candidate)) return previousDelta;
  let delta = candidate.startsWith(baseline) ? candidate.slice(baseline.length) : candidate;
  if (baseline && delta === candidate) {
    const overlap = suffixPrefixOverlap(baseline, candidate);
    delta = candidate.slice(overlap);
  }
  if (!delta) return previousDelta;
  if (!previousDelta) return delta;
  if (delta.startsWith(previousDelta)) return delta;
  if (previousDelta.startsWith(delta) || previousDelta.endsWith(delta)) return previousDelta;
  const overlap = suffixPrefixOverlap(previousDelta, delta);
  return `${previousDelta}${delta.slice(overlap)}`;
}

function suffixPrefixOverlap(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  for (let length = limit; length > 0; length -= 1) {
    if (left.endsWith(right.slice(0, length))) return length;
  }
  return 0;
}

const settledRunStatuses = new Set(["waiting_for_user", "waiting_for_approval", "completed", "failed", "cancelled"]);

/** Executes an orchestrator run after the generic claim has succeeded. */
export async function processDurableOrchestratorRun(store: AgentRunStore, run: AgentRunRecord, context: WorkerContext): Promise<void> {
  const attempt = run.attempt;
  const client = new TrueForge({ baseUrl: trueForgeBaseUrl(), timeoutInSeconds: 60, maxRetries: 0 });
  let sessionId = run.sessionId;
  let turnId = run.turnId;
  let mergedText = "";
  let stateStatus = "running";
  let metrics: RecordValue | undefined;
  const messages = new Map<string, RecordValue>();
  let fallbackDelta = "";
  let tools: string[] = [];
  // Keep the prior Convex content separate from this subscription's text
  // delta. This is important when reconnecting after a provider cursor: each
  // retry candidate must be merged against the same stable prefix.
  let projectionBaseline = "";
  let streamDelta = "";
  let projectedText = "";
  let deltaStream: AssistantDeltaStream | undefined;
  let firstMessage = "";

  try {
    const input = parseDurableOrchestratorInput(run.input);
    firstMessage = input.message;
    const hasResume = run.resumeInput !== undefined && run.resumeInput !== null;
    if (!sessionId && run.conversationId) sessionId = await store.getConversationSession(run.conversationId) ?? undefined;
    if (!sessionId) {
      const { data: session } = await client.sessions.create({ agent: { spec: await orchestratorSpec() as never } });
      sessionId = session.id;
      await requireCheckpoint(await store.checkpointSession({ runId: run._id, attempt, workerId: context.workerId, sessionId }), "checkpoint_session");
      if (run.conversationId) await requireCheckpoint(await store.checkpointConversationSession({ conversationId: run.conversationId, sessionId }), "checkpoint_conversation_session");
    } else {
      let sessionMissing = false;
      try {
        await client.sessions.get(sessionId);
      } catch (error) {
        const retryable = recoverableError(error);
        if (retryable) throw retryable;
        sessionMissing = true;
      }
      if (sessionMissing) {
        const previousSession = sessionId;
        const { data: session } = await client.sessions.create({ agent: { spec: await orchestratorSpec() as never } });
        sessionId = session.id;
        await requireCheckpoint(await store.checkpointSession({ runId: run._id, attempt, workerId: context.workerId, sessionId, expectedSessionId: previousSession }), "checkpoint_recreated_session");
        if (run.conversationId) await requireCheckpoint(await store.checkpointConversationSession({ conversationId: run.conversationId, sessionId, expectedSessionId: previousSession }), "checkpoint_recreated_conversation_session");
        if (hasResume) throw new Error("Cannot resume a paused turn after its TrueForge session was lost");
        turnId = undefined;
      } else {
        try {
          await client.sessions.update(sessionId, { agent: { spec: await orchestratorSpec() as never } });
        } catch (error) {
          workerLog("run.orchestrator_spec_refresh_failed", { runId: run._id, message: error instanceof Error ? error.message.slice(0, 200) : "unknown" });
        }
        if (run.conversationId) {
          await requireCheckpoint(await store.checkpointConversationSession({ conversationId: run.conversationId, sessionId }), "checkpoint_existing_conversation_session");
        }
      }
    }
    if (!sessionId) throw new Error("Orchestrator session was not established");

    if (hasResume) {
      if (!run.turnId || !run.pendingActions) throw new Error("Resume run is missing paused turn or pending actions");
      const turns = await client.sessions.listTurns(sessionId, { limit: 25 });
      const newest = turns.data[0];
      const ids: string[] = [];
      for await (const turn of turns) ids.push(turn.id);
      const oldIndex = ids.indexOf(run.turnId);
      if (oldIndex > 0 && newest) turnId = newest.id;
      else {
        const { data: turn } = await client.sessions.createTurn(sessionId, { input: (Array.isArray(run.resumeInput) ? run.resumeInput : record(run.resumeInput)?.items) as never });
        turnId = turn.id;
      }
      await requireCheckpoint(await store.checkpointSessionTurn({ runId: run._id, attempt, workerId: context.workerId, sessionId, turnId, expectedTurnId: run.turnId }), "checkpoint_resume_turn");
      await requireCheckpoint(await store.acceptResume({ runId: run._id, attempt, workerId: context.workerId, turnId, pendingAction: run.pendingActions, pendingActionSelector: run.pendingActionSelector }), "accept_resume");
    } else if (!turnId) {
      const turns = await client.sessions.listTurns(sessionId, { limit: 25 });
      const newest = turns.data[0];
      if (newest && record(newest.state)?.status === "running") turnId = newest.id;
      else {
        const contextText = await attachedDocumentContext(store, input.documentIds ?? []);
        const { data: turn } = await client.sessions.createTurn(sessionId, { input: turnItems(input, contextText) as never, previousTurnId: "none" as never });
        turnId = turn.id;
      }
      await requireCheckpoint(await store.checkpointSessionTurn({ runId: run._id, attempt, workerId: context.workerId, sessionId, turnId }), "checkpoint_new_turn");
    }
    if (!turnId) throw new Error("Orchestrator turn was not established");

    const operationKey = `assistant:${run._id}`;
    if (run.conversationId && store.getAssistantMessage) {
      const existing = await store.getAssistantMessage(run.conversationId, operationKey);
      if (existing) {
        projectionBaseline = existing.content;
        projectedText = projectionBaseline;
        tools = existing.tools;
      }
    }
    if (run.conversationId) {
      deltaStream = await store.createAssistantDeltaStream({
        conversationId: run.conversationId,
        runId: run._id,
        attempt,
        workerId: context.workerId,
      });
      // A retry starts a fresh official component stream. Seed it with the
      // previously durable prefix so the replacement stream is self-contained.
      if (projectedText) await deltaStream.addText(projectedText);
    }

    // Provider events are replayable by TrueForge. Keep the merge state local
    // and persist only the terminal cursor with the lifecycle outcome.
    const stream = await client.sessions.subscribeToTurn(sessionId, turnId, hasResume ? {} : (run.providerSequence === undefined ? {} : { afterSequenceNumber: run.providerSequence }), { abortSignal: context.signal });
    for await (const metadata of stream.withMetadata()) {
      if (context.signal.aborted) throw new RecoverableRunError("worker_shutdown", "Worker shutdown interrupted provider subscription");
      const event = eventPayload(metadata.data);
      const type = typeof event.type === "string" ? event.type : "unknown";
      const providerSequence = numberCursor(metadata.id);
      if (type === "model.message") {
        if (typeof event.id === "string") messages.set(event.id, event);
      } else if (isEventDelta(metadata.data as never)) {
        if (typeof event.id === "string") {
          const base = messages.get(event.id);
          if (base) mergeEventDelta(base as never, metadata.data as never);
        }
        if (event.threadId === "main" && typeof event.content === "string") fallbackDelta += event.content;
      }
      // Publish through Convex Agent's official delta component. This is the
      // live UI projection; run lifecycle state remains the recovery authority.
      const previousProjectedText = projectedText;
      const candidateText = normalizedText(messages, fallbackDelta);
      streamDelta = mergeStreamingCandidate(projectionBaseline, streamDelta, candidateText);
      projectedText = `${projectionBaseline}${streamDelta}`;
      const streamedTools = toolNamesFromMessages(messages);
      // The merged provider messages are cumulative and ordered, so replacing
      // from that snapshot preserves every call without duplicating replays.
      if (streamedTools.length > 0) tools = streamedTools;
      // Preserve provider order: prose from a delta belongs before a tool that
      // starts in that same delta. The adapter closes that text segment when it
      // receives the first tool-input chunk.
      if (type !== "turn.done" && projectedText.startsWith(previousProjectedText)) {
        await deltaStream?.addText(projectedText.slice(previousProjectedText.length));
      }
      await deltaStream?.syncToolCalls(streamingToolCalls(messages));
      if (type === "tool.response" && typeof event.toolCallId === "string") {
        // The component only needs the lifecycle transition. TrueForge remains
        // authoritative for the potentially large or sensitive result body.
        await deltaStream?.completeToolCall(event.toolCallId);
      } else if (type === "tool.approval_required" && typeof event.id === "string") {
        for (const value of (Array.isArray(event.toolCalls) ? event.toolCalls : [])) {
          const ref = record(value);
          if (typeof ref?.id === "string") {
            await deltaStream?.requestToolApproval(ref.id, `trueforge:${event.id}:${ref.id}`);
          }
        }
      }

      if (type !== "turn.done") continue;

      const state = record(event.state) ?? {};
      stateStatus = typeof state.status === "string" ? state.status : "error";
      metrics = record(state.metrics) ?? undefined;
      const terminalTools = toolNamesFromMessages(messages);
      if (terminalTools.length > 0) tools = terminalTools;
      const outputContent = typeof record(state.output)?.content === "string" ? record(state.output)?.content as string : "";
      const beforeTerminalText = projectedText;
      streamDelta = mergeStreamingCandidate(projectionBaseline, streamDelta, outputContent || normalizedText(messages, fallbackDelta));
      const streamedTerminalText = `${projectionBaseline}${streamDelta}`;
      projectedText = streamedTerminalText;
      if (streamedTerminalText.startsWith(beforeTerminalText)) {
        await deltaStream?.addText(streamedTerminalText.slice(beforeTerminalText.length));
      }
      // The component stream retains the transient narration in its first text
      // segment for realtime continuity. The durable row keeps only the actual
      // response after the final tool call, so reloads never restore the prose
      // the UI intentionally hid.
      mergedText = tools.length > 0
        ? textAfterLastToolCall(messages, fallbackDelta)
        : streamedTerminalText;
      if (stateStatus === "done") {
        const actions = enrichPendingActions(run._id, Array.isArray(state.requiredActions) ? state.requiredActions : [], messages);
        if (actions.length > 0) {
          for (const action of actions) {
            if (action.type !== "tool.approval_required") continue;
            for (const ref of action.toolCalls) {
              await deltaStream?.requestToolApproval(ref.id, action.selector ?? `trueforge:${run._id}:${ref.id}`);
            }
          }
          const waitingStatus = actions.some((action) => action.type === "tool.approval_required") ? "waiting_for_approval" : "waiting_for_user";
          await project(store, run, mergedText, tools, waitingStatus, actions, { attempt, workerId: context.workerId });
          const pendingActionSelector = actions.length === 1 ? actions[0].selector : undefined;
          const paused = actions.some((action) => action.type === "tool.approval_required")
            ? await store.waitForApproval({ runId: run._id, attempt, workerId: context.workerId, turnId, pendingActions: actions, pendingActionSelector, ...(providerSequence !== null ? { providerSequence } : {}) })
            : await store.waitForUser({ runId: run._id, attempt, workerId: context.workerId, turnId, pendingActions: actions, pendingActionSelector, ...(providerSequence !== null ? { providerSequence } : {}) });
          if (!paused) return;
          await deltaStream?.finish();
          workerLog("run.orchestrator_paused", { runId: run._id, attempt, turnId, actionCount: actions.length });
          return;
        }
        await project(store, run, mergedText, tools, completionTokenStatus(metrics), [], { attempt, workerId: context.workerId });
        if (!await store.complete({ runId: run._id, attempt, workerId: context.workerId, turnId, output: { content: mergedText, status: stateStatus, tools, ...(metrics ? { metrics } : {}) }, ...(providerSequence !== null ? { providerSequence } : {}) })) return;
        await deltaStream?.finish();
        try {
          await maybeGenerateConversationTitle(store, client, run.conversationId, firstMessage);
        } catch (error) {
          workerLog("run.title_generation_failed", {
            runId: run._id,
            message: error instanceof Error ? error.message.slice(0, 200) : "unknown",
          });
        }
        return;
      }
      if (stateStatus === "cancelled") {
        await project(store, run, mergedText, tools, "cancelled", [], { attempt, workerId: context.workerId });
        if (!await store.cancel({ runId: run._id, attempt, workerId: context.workerId, turnId, ...(providerSequence !== null ? { providerSequence } : {}) })) return;
        await deltaStream?.finish();
        return;
      }
      const message = typeof state.message === "string" ? state.message : "TrueForge turn returned an error state";
      if (recoverableTerminal(message)) throw new RecoverableRunError("trueforge_terminal_transient", message);
      mergedText = mergedText || message;
      await project(store, run, mergedText, tools, "failed", [], { attempt, workerId: context.workerId });
      if (await store.fail({ runId: run._id, attempt, workerId: context.workerId, turnId, errorCode: "trueforge_terminal", errorMessage: message, ...(providerSequence !== null ? { providerSequence } : {}) })) {
        await deltaStream?.finish();
      }
      return;
    }
    throw new RecoverableRunError("trueforge_stream_ended", "Provider stream ended without turn.done");
  } catch (error) {
    const retryable = recoverableError(error);
    const message = error instanceof Error ? error.message : "Unknown orchestrator worker failure";
    mergedText = mergedText || projectedText;

    // A Convex mutation can commit and still report a transport error. Re-read
    // first; a settled run already has its terminal/pause projection and must
    // not be regressed. Active runs are projected before release/fail so a
    // projection failure cannot bypass the guarded lifecycle transition.
    let latest: AgentRunRecord | null = null;
    let lifecycleApplied = false;
    let lifecycleError: unknown;
    try {
      latest = await store.get(run._id);
    } catch (readFailure) {
      workerLog("run.lifecycle_read_failed", {
        runId: run._id,
        attempt,
        message: readFailure instanceof Error ? readFailure.message.slice(0, 200) : "unknown",
      });
      // Without the authoritative lifecycle snapshot, neither a retrying
      // projection nor a guarded transition is safe after an ambiguous
      // terminal mutation. Abort this attempt's component stream and let
      // redelivery replays from TrueForge's server-side turn buffer.
      await deltaStream?.fail("lifecycle state unavailable").catch(() => undefined);
      throw readFailure;
    }

    const settledStatus = latest && settledRunStatuses.has(latest.status) ? latest.status : undefined;
    let projectionError: unknown;
    if (settledStatus) {
      // The lifecycle mutation may have committed before finish reported an
      // ambiguous transport failure. Retry the idempotent finish while this
      // attempt still owns the stream; aborting is the final fallback so a
      // settled run can never leave a component row stuck in `streaming`.
      try {
        await deltaStream?.finish();
      } catch (finishFailure) {
        try {
          await deltaStream?.fail("durable run settled before stream finalization");
        } catch (abortFailure) {
          workerLog("run.stream_cleanup_failed", {
            runId: run._id,
            attempt,
            finishMessage: finishFailure instanceof Error ? finishFailure.message.slice(0, 200) : "unknown",
            abortMessage: abortFailure instanceof Error ? abortFailure.message.slice(0, 200) : "unknown",
          });
          throw finishFailure;
        }
      }
    } else {
      const projectionStatus = retryable ? "retrying" : "failed";
      try {
        await deltaStream?.fail(retryable ? retryable.message : message).catch(() => undefined);
        await project(store, run, mergedText || message, tools, projectionStatus, [], { attempt, workerId: context.workerId });
      } catch (flushFailure) {
        projectionError = flushFailure;
        workerLog("run.assistant_projection_failed", {
          runId: run._id,
          attempt,
          message: flushFailure instanceof Error ? flushFailure.message.slice(0, 200) : "unknown",
        });
      }

      try {
        lifecycleApplied = retryable
          ? await store.releaseForRetry({ runId: run._id, attempt, workerId: context.workerId, errorCode: retryable.code, errorMessage: retryable.message })
          : await store.fail({ runId: run._id, attempt, workerId: context.workerId, turnId, errorCode: "worker_permanent", errorMessage: message });
      } catch (lifecycleFailure) {
        lifecycleError = lifecycleFailure;
        workerLog("run.lifecycle_transition_failed", {
          runId: run._id,
          attempt,
          retryable: !!retryable,
          message: lifecycleFailure instanceof Error ? lifecycleFailure.message.slice(0, 200) : "unknown",
        });
      }
    }

    // Lifecycle errors remain actionable even when projection failed too; the
    // original retryable error is what BullMQ should redeliver for retries.
    if (lifecycleError) throw lifecycleError;
    if (projectionError && retryable) throw retryable;
    if (retryable && lifecycleApplied) throw retryable;
    if (retryable && !settledStatus) throw retryable;
    if (projectionError) throw projectionError;
  }
}

