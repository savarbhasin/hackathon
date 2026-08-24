import { db } from "@/lib/db";
import { agentSlug, listAgentDefinitions } from "@/lib/agents";

export const runtime = "nodejs";

export async function GET() {
  return Response.json(await listAgentDefinitions());
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as {
    name?: string;
    description?: string;
    instructions?: string;
  } | null;
  const name = body?.name?.trim() ?? "";
  const slug = agentSlug(name);
  const description = body?.description?.trim() ?? "";
  const instructions = body?.instructions?.trim() ?? "";

  if (!name || !slug || !description || instructions.length < 40) {
    return Response.json(
      { error: "Name, description, and at least 40 characters of instructions are required." },
      { status: 400 }
    );
  }

  try {
    const agent = await db.agentProfile.create({
      data: {
        slug,
        name: name.slice(0, 64),
        description: description.slice(0, 240),
        instructions: instructions.slice(0, 12000),
      },
    });
    return Response.json(agent, { status: 201 });
  } catch {
    return Response.json({ error: "An agent with that name already exists." }, { status: 409 });
  }
}
