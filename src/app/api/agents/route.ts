import {
  createAgentDefinition,
  getAgentCatalog,
  registryError,
  type AgentWriteInput,
} from "@/lib/agents";

export const runtime = "nodejs";

export async function GET() {
  try {
    return Response.json(await getAgentCatalog());
  } catch (error) {
    const failure = registryError(error);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as AgentWriteInput | null;
  if (!body) return Response.json({ error: "A JSON agent definition is required." }, { status: 400 });
  try {
    return Response.json(await createAgentDefinition(body), { status: 201 });
  } catch (error) {
    const failure = registryError(error);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
