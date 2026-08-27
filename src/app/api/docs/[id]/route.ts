import {
  convexDocumentId,
  convexDocumentsApi,
  convexDocumentsClient,
  convexMutationError,
  serializeConvexDocument,
} from "@/lib/convex-documents";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Params) {
  const { id } = await ctx.params;
  try {
    const document = await convexDocumentsClient().query(convexDocumentsApi.get, { documentId: convexDocumentId(id) });
    const serialized = serializeConvexDocument(document);
    return serialized ? Response.json(serialized) : Response.json({ error: "not_found" }, { status: 404 });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function PATCH(req: Request, ctx: Params) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    title?: string;
    content?: string;
  } | null;
  if (!body || (body.title === undefined && body.content === undefined)) {
    return Response.json({ error: "title or content required" }, { status: 400 });
  }
  try {
    const document = await convexDocumentsClient().mutation(convexDocumentsApi.update, {
      documentId: convexDocumentId(id),
      ...(body.title !== undefined ? { title: body.title.slice(0, 160) } : {}),
      ...(body.content !== undefined ? { content: body.content } : {}),
    });
    const error = convexMutationError(document);
    if (error) return error;
    const serialized = serializeConvexDocument(document);
    return serialized ? Response.json(serialized) : Response.json({ error: "not_found" }, { status: 404 });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}

export async function DELETE(_req: Request, ctx: Params) {
  const { id } = await ctx.params;
  try {
    const result = await convexDocumentsClient().mutation(convexDocumentsApi.remove, { documentId: convexDocumentId(id) });
    const error = convexMutationError(result);
    if (error) return error;
    return Response.json({ ok: true });
  } catch {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
}
