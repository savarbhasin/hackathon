import { db } from "@/lib/db";
import { tf } from "@/lib/tf";
import { appendTaskEvent } from "@/lib/task-events";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export const runtime = "nodejs";
export const maxDuration = 800;

const locks = new Map<string, Promise<void>>();

interface Event { id: string; type?: string; threadId?: string; content?: string; toolCalls?: Array<{ id?: string; function?: { name?: string } }>; state?: { status?: string; output?: { content?: string } | null } }

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => null) as { message?: string } | null;
  const message = body?.message?.trim();
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
  await appendTaskEvent(id, "chat.user", { content: message });

  const abortController = new AbortController();
  const abort = () => abortController.abort(req.signal.reason);
  if (req.signal.aborted) abort(); else req.signal.addEventListener("abort", abort, { once: true });
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (value: unknown) => {
        if (!abortController.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      };
      let text = "";
      let status = "unknown";
      const events = new Map<string, Event>();
      const tools: string[] = [];
      const emittedContent = new Map<string, number>();
      try {
        const remote = await tf().sessions.createTurnStream(task.sessionId!, { input: [{ type: "user.message", content: message }] as never }, { abortSignal: abortController.signal });
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
            }
            continue;
          }
          events.set(event.id, event);
          if (event.type === "model.message.delta" && event.threadId === "main" && event.content) {
            text += event.content; send({ kind: "delta", text: event.content });
          }
          if (event.type === "model.message") {
            for (const call of event.toolCalls ?? []) if (call.function?.name) { tools.push(call.function.name); send({ kind: "tool", name: call.function.name }); }
          }
          if (event.type === "turn.done") {
            status = event.state?.status ?? "unknown";
            if (event.state?.output?.content) text = event.state.output.content;
          }
        }
        await appendTaskEvent(id, "chat.assistant", { content: text, tools, status });
        send({ kind: "done", content: text, status });
      } catch (error) {
        const detail = String(error).slice(0, 500);
        await appendTaskEvent(id, "chat.assistant", { content: `The chat turn failed: ${detail}`, status: "error" });
        send({ kind: "error", text: "The chat turn could not be completed." });
      } finally {
        req.signal.removeEventListener("abort", abort);
        locks.delete(id);
        release();
        if (!abortController.signal.aborted) { controller.enqueue(encoder.encode("data: [DONE]\n\n")); controller.close(); }
      }
    },
    cancel() { abortController.abort("client_disconnected"); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
