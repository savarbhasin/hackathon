import { db } from "@/lib/db";

export const runtime = "nodejs";

export async function GET() {
  const schedules = await db.schedule.findMany({ orderBy: { createdAt: "desc" } });
  return Response.json(schedules);
}
