import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const documents = await db.document.findMany({
    include: {
      mission: { select: { id: true, title: true } },
      task: { select: { id: true, title: true, role: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return Response.json(documents);
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    content?: string;
  };
  const document = await db.document.create({
    data: {
      title: body.title?.slice(0, 160) || "Untitled document",
      content: body.content ?? "",
      authorRole: "user",
    },
  });
  return Response.json(document, { status: 201 });
}
