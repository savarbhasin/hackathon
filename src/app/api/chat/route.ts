import { resumeOrchestratorTurn, runOrchestratorTurn } from "@/lib/orchestrator";
import { parseResumeSelections, ResumeStateError, type ResumeSelection } from "@/lib/orchestrator-pause";

export const runtime = "nodejs";
export const maxDuration = 800;

interface ChatBody {
  message?: string;
  conversationId?: string;
  documentIds?: unknown;
  answers?: unknown;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ChatBody | null;
  const isResume = body?.answers !== undefined;
  let selections: ResumeSelection[] | undefined;

  if (isResume) {
    if (!body?.conversationId || typeof body.conversationId !== "string") {
      return Response.json({ error: "conversation_id_required", message: "A conversation is required to resume a paused action." }, { status: 400 });
    }
    try {
      selections = parseResumeSelections(body.answers);
    } catch (error) {
      return Response.json(resumeErrorBody(error), { status: 400 });
    }
  } else if (!body?.message?.trim()) {
    return Response.json({ error: "message_required", message: "Enter a message before sending." }, { status: 400 });
  }

  const abortController = new AbortController();
  const abort = () => abortController.abort(req.signal.reason);
  if (req.signal.aborted) abort();
  else req.signal.addEventListener("abort", abort, { once: true });

  const turn = selections
    ? resumeOrchestratorTurn(body!.conversationId!, selections, abortController.signal)
    : runOrchestratorTurn(
      body!.message!.trim(),
      body?.conversationId,
      Array.isArray(body?.documentIds) ? body.documentIds.filter((id): id is string => typeof id === "string") : [],
      abortController.signal
    );

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (!abortController.signal.aborted) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        }
      };
      try {
        for await (const event of turn) send(event);
      } catch (error) {
        if (!abortController.signal.aborted) {
          send({ kind: "error", ...resumeErrorBody(error) });
          send({ kind: "done", text: errorMessage(error), name: "error" });
        }
      } finally {
        req.signal.removeEventListener("abort", abort);
        if (!abortController.signal.aborted) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      }
    },
    cancel() {
      abortController.abort("client_disconnected");
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function resumeErrorBody(error: unknown): { code: string; text: string } {
  if (error instanceof ResumeStateError) return { code: error.code, text: error.message };
  return { code: "turn_failed", text: "The turn could not be completed. Try again." };
}

function errorMessage(error: unknown): string {
  return error instanceof ResumeStateError ? error.message : "The turn could not be completed. Try again.";
}
