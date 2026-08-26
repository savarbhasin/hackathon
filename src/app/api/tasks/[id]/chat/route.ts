import { db } from "@/lib/db";
import { durableRunsEnabled } from "@/lib/queue/env";
import { handleDone } from "@/lib/engine";
import { tf } from "@/lib/tf";
import { appendTaskEvent } from "@/lib/task-events";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export const runtime = "nodejs";
export const maxDuration = 800;

const locks = new Map<string, Promise<void>>();

interface Event { id: string; type?: string; threadId?: string; content?: string; toolCalls?: Array<{ id?: string; function?: { name?: string } }>; state?: { status?: string; output?: { content?: string } | null } }

function emitToolCalls(event: Event, tools: string[], emitted: Set<string>, send: (value: unknown) => void) {
  for (const [index, call] of (event.toolCalls ?? []).entries()) {
    const name = call.function?.name;
    const key = `${call.id ?? index}:${name ?? ""}`;
    if (name && !emitted.has(key)) {
      emitted.add(key);
      tools.push(name);
      send({ kind: "tool", name });
    }
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { message?: string; clientMessageId?: string } | null;
  const message = body?.message?.trim();
  const clientMessageId = body?.clientMessageId?.trim() || undefined;
  if (durableRunsEnabled()) {
    return Response.json({
      error: "durable_followup_unsupported",
      code: "durable_followup_unsupported",
      mode: "durable",
      message: "Durable task follow-up chat is not available yet. Use the task actions above; Phase 4 will add subscribed follow-up runs.",
    }, { status: 409 });
  }
  if (!message) return Response.json({ error: "message_required" }, { status: 400 });
  const task = await db.task.findUnique({ where: { id }, select: { sessionId: true, column: true } });
  if (!task) return Response.json({ error: "not_found" }, { status: 404 });
  if (!task.sessionId) return Response.json({ error: "no_session" }, { status: 409 });
  if (task.column === "working") return Response.json({ error: "agent_busy" }, { status: 409 });
  if (task.column === "approval" || task.column === "blocked") return Response.json({ error: "resolve_pause_first" }, { status: 409 });

  const previous = locks.get(id);
  if (previous) return Response.json({ error: "chat_busy" }, { status: 409 });
  let release!: () => void;
  const lock = new Promise<void>((resolve) => { release = resolve; });
  locks.set(id, lock);
  try {
    await appendTaskEvent(id, "chat.user", { content: message, clientMessageId }, { preservePayload: true });
  } catch (error) {
    locks.delete(id);
    release();
    console.error("[task-chat] failed to persist user message", error);
    return Response.json({ error: "chat_unavailable" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let clientDisconnected = req.signal.aborted;
  const onAbort = () => { clientDisconnected = true; };
  req.signal.addEventListener("abort", onAbort, { once: true });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        if (!clientDisconnected) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      let text = "";
      let status = "unknown";
      const events = new Map<string, Event>();
      const tools: string[] = [];
      const emittedToolIds = new Set<string>();
      const emittedContent = new Map<string, number>();
      try {
        const remote = await tf().sessions.createTurnStream(task.sessionId!, { input: [{ type: "user.message", content: message }] as never });
        for await (const { data } of remote.withMetadata()) {
          const event = data as unknown as Event;
          if (isEventDelta(data)) {
            const base = events.get(event.id);
            if (base) {
              mergeEventDelta(base as never, event as never);
              if (base.type === "model.message" && base.threadId === "main" && base.content) {
                const offset = emittedContent.get(event.id) ?? 0;
                const next = base.content.slice(offset);
                emittedContent.set(event.id, base.content.length);
                if (next) { text += next; send({ kind: "delta", text: next }); }
              }
              if (base.type === "model.message") emitToolCalls(base, tools, emittedToolIds, send);
            }
            continue;
          }
          events.set(event.id, event);
          if (event.type === "model.message.delta" && event.threadId === "main" && event.content) {
            text += event.content; send({ kind: "delta", text: event.content });
          }
          if (event.type === "model.message") emitToolCalls(event, tools, emittedToolIds, send);
          if (event.type === "turn.done") {
            status = event.state?.status ?? "unknown";
            if (event.state?.output?.content) text = event.state.output.content;
            // Keep follow-up turns on the same canonical pause/completion path as task runs.
            await handleDone(id, task.sessionId!, event as never, events as never);
          }
        }
        await appendTaskEvent(id, "chat.assistant", { content: text, tools, status, clientMessageId }, { preservePayload: true });
        send({ kind: "done", content: text, status });
      } catch (error) {
        const detail = String(error).slice(0, 500);
        await appendTaskEvent(id, "chat.assistant", { content: `The chat turn failed: ${detail}`, status: "error", clientMessageId }, { preservePayload: true });
        send({ kind: "error", text: "The chat turn could not be completed." });
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        locks.delete(id);
        release();
        if (!clientDisconnected) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
      }
    },
    // Client cancellation must not cancel the already-accepted provider turn.
    cancel() { clientDisconnected = true; },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
