import {
  registryError,
  updateAgentDefinition,
  type AgentWriteInput,
} from "@/lib/agents";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as AgentWriteInput | null;
  if (!body) return Response.json({ error: "A JSON agent definition is required." }, { status: 400 });
  try {
    return Response.json(await updateAgentDefinition(id, body));
  } catch (error) {
    const failure = registryError(error);
    return Response.json({ error: failure.message }, { status: failure.status });
  }
}
