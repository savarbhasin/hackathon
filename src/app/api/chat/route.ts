import { admitDurableResume, admitDurableStart } from "@/lib/durable-chat-admission";
import { ResumeStateError } from "@/lib/orchestrator-pause";

export const runtime = "nodejs";
export const maxDuration = 800;

interface ChatBody {
  message?: unknown;
  conversationId?: unknown;
  documentIds?: unknown;
  answers?: unknown;
  requestId?: unknown;
  idempotencyKey?: unknown;
  operationKey?: unknown;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as ChatBody | null;
  const headerKey = req.headers.get("idempotency-key");
  if (!body || typeof body !== "object") {
    return Response.json({ error: "invalid_request", code: "invalid_request" }, { status: 400 });
  }

  const isResume = body.answers !== undefined;
  try {
    const result = isResume
      ? (() => {
        if (typeof body.conversationId !== "string" || !body.conversationId.trim()) {
          throw new DurableRequestError("conversation_id_required", "A conversation is required to resume a paused action.");
        }
        return admitDurableResume({
          conversationId: body.conversationId.trim(),
          answers: body.answers,
          requestKey: body.requestId ?? body.idempotencyKey ?? body.operationKey,
          idempotencyHeader: headerKey,
        });
      })()
      : (() => {
        if (typeof body.message !== "string" || !body.message.trim()) {
          throw new DurableRequestError("message_required", "Enter a message before sending.");
        }
        if (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !body.conversationId.trim())) {
          throw new DurableRequestError("invalid_conversation_id", "The conversation ID must be text.");
        }
        if (body.documentIds !== undefined && (!Array.isArray(body.documentIds) || body.documentIds.some((id) => typeof id !== "string"))) {
          throw new DurableRequestError("invalid_document_ids", "Document IDs must be an array of text values.");
        }
        return admitDurableStart({
          message: body.message.trim(),
          conversationId: typeof body.conversationId === "string" ? body.conversationId.trim() : undefined,
          documentIds: Array.isArray(body.documentIds) ? body.documentIds as string[] : [],
          requestKey: body.requestId ?? body.idempotencyKey ?? body.operationKey,
          idempotencyHeader: headerKey,
        });
      })();
    const admitted = await result;
    return durableAdmissionResponse(admitted);
  } catch (error) {
    if (error instanceof DurableRequestError || error instanceof ResumeStateError) {
      const code = error instanceof DurableRequestError ? error.code : error.code;
      return Response.json({ error: code, code, message: error.message }, { status: 400 });
    }
    // Deliberately do not include provider, Convex, Redis, or request details.
    return Response.json({ error: "durable_admission_failed", code: "durable_admission_failed" }, { status: 503 });
  }
}

class DurableRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function durableAdmissionResponse(result: {
  kind: string;
  conversationId?: string;
  runId?: string;
  status?: string;
  reason?: string;
  selector?: string;
  queue?: { kind: string; jobId?: string; state?: string; code?: string };
}): Response {
  const queue = result.queue;
  const body = {
    admissionKind: result.kind,
    ...(result.conversationId ? { conversationId: result.conversationId } : {}),
    ...(result.runId ? { runId: result.runId } : {}),
    ...(result.status ? { status: result.status } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.selector ? { selector: result.selector } : {}),
    ...(queue ? { queue } : {}),
  };
  if (queue?.kind === "error") {
    return Response.json({ ...body, error: queue.code ?? "enqueue_failed", code: queue.code ?? "enqueue_failed" }, { status: 503 });
  }
  if (result.kind === "accepted") return Response.json(body, { status: 202 });
  if (result.kind === "already_accepted") return Response.json(body, { status: 200 });
  if (result.kind === "busy" || result.kind === "selector_mismatch" || result.kind === "invalid_state" || result.kind === "missing") {
    const status = result.kind === "missing" && result.reason === "conversation_not_found" ? 404 : result.kind === "missing" ? 409 : 409;
    return Response.json({ ...body, error: result.kind, code: result.kind }, { status });
  }
  return Response.json({ ...body, error: result.kind, code: result.kind }, { status: 400 });
}
