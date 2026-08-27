import {
  convexDocumentsApi,
  convexDocumentsClient,
  convexMutationError,
  serializeConvexDocument,
} from "@/lib/convex-documents";

export const runtime = "nodejs";

export async function GET() {
  try {
    const documents = await convexDocumentsClient().query(convexDocumentsApi.list, { limit: 200 });
    return Response.json(Array.isArray(documents) ? documents.map(serializeConvexDocument).filter(Boolean) : []);
  } catch {
    return Response.json({ error: "Could not load documents." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
  };
  try {
    const document = await convexDocumentsClient().mutation(convexDocumentsApi.save, {
      operationKey: `user-doc:${crypto.randomUUID()}`,
      title: body.title?.slice(0, 160) || "Untitled document",
      content: body.content ?? "",
      authorRole: "user",
      kind: "user",
    });
    const error = convexMutationError(document);
    if (error) return error;
    const serialized = serializeConvexDocument(document);
    if (!serialized) return Response.json({ error: "Document created but no document id was returned." }, { status: 502 });
    return Response.json(serialized, { status: 201 });
  } catch {
    return Response.json({ error: "Could not create the document." }, { status: 500 });
  }
}
