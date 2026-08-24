import { db } from "@/lib/db";
import { agentSlug } from "@/lib/agents";
import { ROLES } from "@/lib/fleet";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as {
    slug?: string;
    name?: string;
    description?: string;
    instructions?: string;
    enabled?: boolean;
  } | null;
  const name = body?.name?.trim() ?? "";
  const description = body?.description?.trim() ?? "";
  const instructions = body?.instructions?.trim() ?? "";
  const presetSlug = id.startsWith("preset:") ? agentSlug(id.slice(7)) : "";
  const slug = presetSlug || agentSlug(body?.slug ?? "");

  if (!slug || !name || !description || instructions.length < 40) {
    return Response.json(
      { error: "Name, description, and at least 40 characters of instructions are required." },
      { status: 400 }
    );
  }

  const data = {
    name: name.slice(0, 64),
    description: description.slice(0, 240),
    instructions: instructions.slice(0, 12000),
    enabled: body?.enabled ?? true,
  };

  try {
    const agent = presetSlug
      ? await db.agentProfile.upsert({
          where: { slug },
          create: { slug, ...data, isDefault: Boolean(ROLES[slug]) },
          update: data,
        })
      : await db.agentProfile.update({ where: { id }, data });
    return Response.json(agent);
  } catch {
    return Response.json({ error: "Agent not found." }, { status: 404 });
  }
}
