import { db } from "./db";
import { tf } from "./tf";
import { ORCHESTRATOR_INSTRUCTIONS, ORCHESTRATOR_SPEC, TITLE_MODEL } from "./fleet";
import { agentRosterBlock } from "./agents";
import { createConversationTurnLock, ConversationTurnAbortedError } from "./conversation-turn-lock";
import {
  buildProviderResumeInput,
  createPauseSelector,
  parsePersistedPauseActions,
  toClientPauseAction,
  type PauseAction,
  type PersistedPauseAction,
  type ResumeSelection,
  ResumeStateError,
} from "./orchestrator-pause";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

const conversationTurnLock = createConversationTurnLock();

async function orchestratorSpec(): Promise<TrueForgeApi.AgentSpec> {
  const roster = await agentRosterBlock();
  if (!roster) return ORCHESTRATOR_SPEC;
  return {
    ...ORCHESTRATOR_SPEC,
    instructions: `${ORCHESTRATOR_INSTRUCTIONS}\n\n${roster}`,
  };
}

async function createOrchestratorSession(): Promise<string> {
  const { data: session } = await tf().sessions.create({
    agent: { spec: await orchestratorSpec() as never },
  });
  return session.id;
}

async function ensureConversation(conversationId: string | undefined, message: string) {
  let conversation = conversationId
    ? await db.conversation.findUnique({ where: { id: conversationId } })
    : null;

  if (conversationId && !conversation) throw new Error("Conversation not found");

  if (!conversation) {
    const [sessionId, title] = await Promise.all([
      createOrchestratorSession(),
      generateConversationTitle(message),
    ]);
    conversation = await db.conversation.create({
      data: { title, sessionId },
    });
  } else {
    try {
      await tf().sessions.get(conversation.sessionId);
      await tf().sessions.update(conversation.sessionId, {
        agent: { spec: await orchestratorSpec() as never },
      });
    } catch {
      const sessionId = await createOrchestratorSession();
      conversation = await db.conversation.update({
        where: { id: conversation.id },
        data: { sessionId },
      });
    }
  }

  return conversation;
}

export interface ChatEventMetrics {
  totalCostInUsd?: number;
  totalTokens?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalReasoningTokens?: number;
}

export interface ChatEvent {
  kind: "conversation" | "delta" | "tool" | "status" | "pause" | "error" | "done";
  text?: string;
  name?: string;
  code?: string;
  conversationId?: string;
  metrics?: ChatEventMetrics;
  actions?: PauseAction[];
  completed?: boolean;
  _persistedActions?: PersistedPauseAction[];
}

interface StreamEvent {
  id: string;
  type?: string;
  threadId?: string;
  content?: string;
  toolCalls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
  state?: {
    status?: string;
    output?: { content?: string } | null;
    metrics?: ChatEventMetrics;
  };
}

export async function* runOrchestratorTurn(
  message: string,
  conversationId?: string,
  documentIds: string[] = [],
  abortSignal?: AbortSignal
): AsyncGenerator<ChatEvent> {
  let release = conversationId
    ? await conversationTurnLock.acquire(conversationId, abortSignal)
    : undefined;
  try {
    throwIfAborted(abortSignal);
    const conversation = await ensureConversation(conversationId, message);
    release ??= await conversationTurnLock.acquire(conversation.id, abortSignal);
    throwIfAborted(abortSignal);
  await db.$transaction([
    db.chatMessage.create({
      data: { conversationId: conversation.id, role: "user", content: message },
    }),
    db.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    }),
  ]);

  yield { kind: "conversation", conversationId: conversation.id };

  let finalText = "";
  let streamedText = "";
  let status = "unknown";
  let statusText: string | undefined;
  let pauseActions: PersistedPauseAction[] = [];
  const tools: string[] = [];

  const documentContext = await attachedDocumentContext(documentIds);
  try {
    for await (const event of streamSessionTurn(
      conversation.sessionId,
      [{ type: "user.message", content: `${message}${documentContext}` }],
      abortSignal
    )) {
      if (event.kind === "delta") streamedText += event.text ?? "";
      if (event.kind === "tool" && event.name) tools.push(event.name);
      if (event.kind === "status") statusText = event.text;
      if (event.kind === "pause") pauseActions = event._persistedActions ?? [];
      if (event.kind === "done") {
        finalText = event.text ?? "";
        status = event.name ?? "unknown";
      }
      yield event;
    }
  } catch (error) {
    finalText = `Error: ${String(error).slice(0, 300)}`;
    status = "error";
    yield { kind: "error", code: "turn_stream_failed", text: finalText };
    yield { kind: "done", text: finalText, name: status };
  }

  await db.chatMessage.create({
    data: {
      conversationId: conversation.id,
      role: "assistant",
      content: finalText || streamedText,
      tools: JSON.stringify(tools),
      status: statusText ?? status,
      pauseActions: pauseActions.length > 0 ? JSON.stringify(pauseActions) : null,
    },
  });
  await db.conversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });
  } finally {
    release?.();
  }
}

async function attachedDocumentContext(documentIds: string[]): Promise<string> {
  const ids = [...new Set(documentIds)].filter(Boolean).slice(0, 5);
  if (ids.length === 0) return "";
  const documents = await db.document.findMany({
    where: { id: { in: ids } },
    select: { title: true, content: true },
  });
  if (documents.length === 0) return "";
  const context = documents.map((document) =>
    `Document: ${document.title}\n${document.content.slice(0, 16000)}`
  ).join("\n\n---\n\n");
  return `\n\nThe user attached these saved documents as working context. Use them when relevant.\n\n${context}`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ConversationTurnAbortedError();
}

export async function* resumeOrchestratorTurn(
  conversationId: string,
  selections: ResumeSelection[],
  abortSignal?: AbortSignal
): AsyncGenerator<ChatEvent> {
  const release = await conversationTurnLock.acquire(conversationId, abortSignal);
  try {
  throwIfAborted(abortSignal);
  const conversation = await db.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) throw new Error("Conversation not found");

  const pausedMessage = await db.chatMessage.findFirst({
    where: { conversationId: conversation.id, pauseActions: { not: null } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true, pauseActions: true },
  });
  if (!pausedMessage?.pauseActions) {
    throw new ResumeStateError("no_pending_pause", "There is no current paused action for this conversation.");
  }

  const persistedActions = parsePersistedPauseActions(pausedMessage.pauseActions, pausedMessage.id);
  const input = buildProviderResumeInput(persistedActions, selections);
  const answerSummary = selections.map((selection) =>
    selection.decision === "allow" ? "Approved" : selection.decision === "deny" ? "Denied" : selection.content?.trim() ?? ""
  ).filter(Boolean).join(" | ");

  yield { kind: "conversation", conversationId: conversation.id };

  let finalText = "";
  let streamedText = "";
  let status = "unknown";
  let statusText: string | undefined;
  let pauseActions: PersistedPauseAction[] = [];
  let providerCompleted = false;
  const tools: string[] = [];

  try {
    for await (const event of streamSessionTurn(conversation.sessionId, input, abortSignal)) {
      if (event.kind === "delta") streamedText += event.text ?? "";
      if (event.kind === "tool" && event.name) tools.push(event.name);
      if (event.kind === "status") statusText = event.text;
      if (event.kind === "pause") pauseActions = event._persistedActions ?? [];
      if (event.kind === "done") {
        finalText = event.text ?? "";
        status = event.name ?? "unknown";
        providerCompleted = event.completed === true;
      }
      yield event;
    }
  } catch (error) {
    const code = error instanceof ConversationTurnAbortedError ? "turn_cancelled" : "resume_stream_failed";
    const text = code === "turn_cancelled"
      ? "The resume stream was cancelled. The paused action is still available."
      : "The resume did not complete. The paused action is still available.";
    yield { kind: "error", code, text };
    yield { kind: "done", text, name: "error" };
    return;
  }

  if (!providerCompleted) {
    const text = "The provider ended before confirming this resume. The paused action is still available.";
    yield { kind: "error", code: "resume_incomplete", text };
    yield { kind: "done", text, name: "error" };
    return;
  }

  await db.$transaction([
    db.chatMessage.create({
      data: { conversationId: conversation.id, role: "user", content: answerSummary || "Responded to paused action" },
    }),
    db.chatMessage.create({
      data: {
        conversationId: conversation.id,
        role: "assistant",
        content: finalText || streamedText,
        tools: JSON.stringify(tools),
        status: statusText ?? status,
        pauseActions: pauseActions.length > 0 ? JSON.stringify(pauseActions) : null,
      },
    }),
    db.chatMessage.update({
      where: { id: pausedMessage.id },
      data: { pauseActions: null },
    }),
    db.conversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    }),
  ]);
  } finally {
    release();
  }
}

async function* streamSessionTurn(
  sessionId: string,
  input: Array<object>,
  abortSignal?: AbortSignal
): AsyncGenerator<ChatEvent> {
  const stream = await tf().sessions.createTurnStream(sessionId, {
    input: input as never,
  }, { abortSignal });

  let finalText = "";
  let status = "unknown";
  let completed = false;
  const events = new Map<string, StreamEvent>();
  const seenTools = new Set<string>();

  function* newToolEvents(message: StreamEvent): Generator<ChatEvent> {
    for (const [index, call] of (message.toolCalls ?? []).entries()) {
      const key = call.id ?? `${message.id}:${index}`;
      const name = resolvedToolName(call);
      if (!name || seenTools.has(key)) continue;
      seenTools.add(key);
      yield { kind: "tool", name };
    }
  }

  for await (const { data: event } of stream.withMetadata()) {
    const ev = event as StreamEvent;

    if (isEventDelta(event)) {
      const base = events.get(ev.id);
      if (base) {
        mergeEventDelta(base as never, ev as never);
        yield* newToolEvents(base);
      }
      continue;
    }

    switch (ev.type) {
      case "model.message": {
        events.set(ev.id, ev);
        yield* newToolEvents(ev);
        break;
      }
      case "model.message.delta":
        if (ev.threadId === "main" && ev.content) yield { kind: "delta", text: ev.content };
        break;
      case "tool.approval_required":
        yield { kind: "status", text: "waiting for approval on a specialist card" };
        break;
      case "turn.done":
        status = ev.state?.status ?? "unknown";
        finalText = ev.state?.output?.content ?? "";
        completed = true;
        {
          const ras = (ev.state as { requiredActions?: unknown[]; required_actions?: unknown[] })
            ?.requiredActions ??
            (ev.state as { required_actions?: unknown[] })?.required_actions ?? [];
          if (ras.length > 0) {
            const persistedActions = extractPauseActions(ras, events);
            const pauseEvent: ChatEvent = {
              kind: "pause",
              actions: persistedActions.map(toClientPauseAction),
            };
            Object.defineProperty(pauseEvent, "_persistedActions", {
              value: persistedActions,
              enumerable: false,
            });
            yield pauseEvent;
          }
        }
        {
          const m = ev.state?.metrics;
          if (m) {
            yield { kind: "status", text: formatMetrics(m), metrics: m };
          }
        }
        break;
    }
  }

  yield { kind: "done", text: finalText, name: status, completed };
}

function titleFromMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 69)}...`;
}

async function generateConversationTitle(message: string): Promise<string> {
  let sessionId: string | undefined;
  try {
    const { data: session } = await tf().sessions.create({
      agent: {
        spec: {
          model: { name: TITLE_MODEL },
          instructions:
            "Write a specific 3 to 7 word title for the user's request. Use sentence case. Return only the title, with no quotes or punctuation at the end.",
        } as never,
      },
    });
    sessionId = session.id;
    let title = "";
    const stream = await tf().sessions.createTurnStream(sessionId, {
      input: [{ type: "user.message", content: message }] as never,
    });
    for await (const { data: event } of stream.withMetadata()) {
      const ev = event as StreamEvent;
      if (ev.type === "model.message.delta" && ev.threadId === "main" && ev.content) {
        title += ev.content;
      }
      if (ev.type === "turn.done" && ev.state?.output?.content) {
        title = ev.state.output.content;
      }
    }
    const clean = title.replace(/^[\s"'`]+|[\s"'`.]+$/g, "").replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, 80) : titleFromMessage(message);
  } catch {
    return titleFromMessage(message);
  } finally {
    if (sessionId) await tf().sessions.delete(sessionId).catch(() => undefined);
  }
}

function resolvedToolName(call: NonNullable<StreamEvent["toolCalls"]>[number]): string | undefined {
  const name = call.function?.name;
  if (!name) return undefined;
  if (name !== "call_tool") return name;
  if (!call.function?.arguments) return undefined;
  try {
    const parsed = JSON.parse(call.function.arguments) as {
      mcp_server?: string;
      tool_name?: string;
    };
    if (!parsed.tool_name) return undefined;
    return parsed.mcp_server ? `${parsed.mcp_server}.${parsed.tool_name}` : parsed.tool_name;
  } catch {
    return undefined;
  }
}

function extractPauseActions(
  requiredActions: unknown[],
  events: Map<string, StreamEvent>
): PersistedPauseAction[] {
  const out: PersistedPauseAction[] = [];
  const actions = requiredActions as Array<{
    type?: string;
    threadId?: string | null;
    toolCalls?: Array<{ id: string; sourceEventId?: string }>;
  }>;
  for (const ra of actions) {
    for (const ref of ra.toolCalls ?? []) {
      const msg = ref.sourceEventId ? events.get(ref.sourceEventId) : undefined;
      const call = (msg?.toolCalls ?? []).find((tc) => tc.id === ref.id);
      let question: string | undefined;
      let options: string[] | undefined;
      if (call?.function?.arguments) {
        try {
          const parsed = JSON.parse(call.function.arguments) as {
            question?: string;
            options?: string[];
          };
          question = parsed.question;
          options = parsed.options;
        } catch {
          /* non-question client tool */
        }
      }
      out.push({
        selector: createPauseSelector(),
        type: String(ra.type ?? ""),
        threadId: (ra.threadId as string | null) ?? undefined,
        toolCallId: ref.id,
        name: call?.function?.name,
        question,
        options,
        argsPreview: call?.function?.arguments?.slice(0, 300),
      });
    }
  }
  return out;
}

function formatMetrics(m: ChatEventMetrics): string {
  const total = m.totalTokens ?? 0;
  const parts: string[] = [];
  if (m.totalCostInUsd != null && Number.isFinite(m.totalCostInUsd)) {
    const digits = m.totalCostInUsd < 0.01 ? 4 : 2;
    parts.push(`est. $${m.totalCostInUsd.toFixed(digits)}`);
  }
  if (total > 0) parts.push(`${total.toLocaleString()} tokens`);
  if (m.totalInputTokens != null || m.totalOutputTokens != null) {
    parts.push(`in ${m.totalInputTokens ?? 0} / out ${m.totalOutputTokens ?? 0}`);
  }
  return parts.join(" · ") || "usage unavailable";
}

export async function orchestratorSay(prompt: string): Promise<string> {
  const key = "orchestrator_automation_session_id";
  const existing = await db.setting.findUnique({ where: { key } });
  let sessionId = existing?.value;
  if (sessionId) {
    try {
      await tf().sessions.get(sessionId);
      await tf().sessions.update(sessionId, {
        agent: { spec: await orchestratorSpec() as never },
      });
    } catch {
      sessionId = undefined;
    }
  }
  if (!sessionId) {
    sessionId = await createOrchestratorSession();
    await db.setting.upsert({
      where: { key },
      create: { key, value: sessionId },
      update: { value: sessionId },
    });
  }

  let finalText = "";
  for await (const ev of streamSessionTurn(sessionId, [
    { type: "user.message", content: prompt },
  ])) {
    if (ev.kind === "done") finalText = ev.text ?? "";
  }
  return finalText;
}
