import { db } from "@/lib/db";
import { Cron } from "croner";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const month = requestedMonth(req.url);
  const schedules = await db.schedule.findMany({ orderBy: { createdAt: "desc" } });
  return Response.json(schedules.map((schedule) => ({
    ...schedule,
    nextRuns: schedule.enabled ? nextRuns(schedule.cronExpr) : [],
    calendarRuns: schedule.enabled && month ? runsInMonth(schedule.cronExpr, month) : [],
  })));
}

function nextRuns(cronExpr: string): string[] {
  try {
    return new Cron(cronExpr).nextRuns(4).map((run) => run.toISOString());
  } catch {
    return [];
  }
}

function requestedMonth(url: string): Date | null {
  const value = new URL(url).searchParams.get("month");
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  const [year, month] = value.split("-").map(Number);
  return new Date(year, month - 1, 1);
}

function runsInMonth(cronExpr: string, month: Date): string[] {
  try {
    const cron = new Cron(cronExpr);
    const end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
    let cursor = new Date(month.getTime() - 1_000);
    const runs: string[] = [];
    for (let count = 0; count < 1_000; count += 1) {
      const next = cron.nextRun(cursor);
      if (!next || next >= end) break;
      runs.push(next.toISOString());
      cursor = next;
    }
    return runs;
  } catch {
    return [];
  }
}
