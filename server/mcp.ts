import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Cron } from "croner";
import { db } from "../src/lib/db";
import { tf } from "../src/lib/tf";
import { ROLES } from "../src/lib/fleet";
import { dispatchTask, getBoard, sweep } from "../src/lib/engine";
import { orchestratorSay } from "../src/lib/orchestrator";

const PORT = Number(process.env.MCP_PORT ?? 3100);

const jobs = new Map<string, Cron>();

function text(t: unknown) {
  return { content: [{ type: "text" as const, text: typeof t === "string" ? t : JSON.stringify(t) }] };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mission-control", version: "0.1.0" });

  server.tool(
    "mark_done",
    "Signal that your assigned task is complete. Call this exactly once when work is finished.",
    {
      task_id: z.string().describe("The TASK_ID given in your assignment"),
      summary: z.string().describe("What you accomplished, concise and factual"),
      handoff: z
        .string()
        .optional()
        .describe("Key findings/decisions/artifacts downstream tasks need to continue without repeating your work"),
    },
    async ({ task_id, summary, handoff }) => {
      const task = await db.task.update({
        where: { id: task_id },
        data: { handoff: handoff ?? null, output: summary },
      }).catch(() => null);
      if (!task) return text(`Unknown task_id ${task_id}`);
      await db.taskEvent.create({
        data: { taskId: task_id, seq: 900000, type: "specialist.mark_done", payload: JSON.stringify({ summary, handoff }) },
      });
      return text(`Recorded. Task ${task.title} will settle when your turn ends.`);
    }
  );

  server.tool(
    "list_board",
    "Current state of all missions and tasks on the kanban board.",
    {},
    async () => text(await getBoard())
  );

  server.tool(
    "get_task",
    "Full detail of one task including its recent event log.",
    { task_id: z.string() },
    async ({ task_id }) => {
      const task = await db.task.findUnique({
        where: { id: task_id },
        include: { events: { orderBy: { seq: "desc" }, take: 20 } },
      });
      return text(task ?? `No task ${task_id}`);
    }
  );

  server.tool(
    "create_mission",
    "Create a mission (a goal that will be broken into tasks). Returns the mission id.",
    { title: z.string(), goal: z.string().describe("What success looks like") },
    async ({ title, goal }) => {
      const mission = await db.mission.create({ data: { title, goal, status: "active" } });
      return text(`Mission created. id=${mission.id} title="${mission.title}"`);
    }
  );

  server.tool(
    "create_task",
    "Create one task on a mission's kanban board. One agent will be assigned to it.",
    {
      mission_id: z.string(),
      title: z.string(),
      detail: z.string().describe("Self-contained instructions for the assigned agent"),
      role: z.enum(["researcher", "writer", "filer"]).describe(`Available roles: ${Object.keys(ROLES).join(", ")}`),
      depends_on: z.array(z.string()).default([]).describe("Task ids that must finish before this one starts"),
    },
    async ({ mission_id, title, detail, role, depends_on }) => {
      const count = await db.task.count({ where: { missionId: mission_id } });
      const task = await db.task.create({
        data: {
          missionId: mission_id,
          title,
          detail,
          role,
          dependsOn: JSON.stringify(depends_on),
          position: count,
        },
      });
      void sweep();
      return text(`Task created. id=${task.id} column=backlog`);
    }
  );

  server.tool(
    "dispatch_task",
    "Start an agent on a backlog task immediately, even if dependencies are unmet.",
    { task_id: z.string() },
    async ({ task_id }) => text(await dispatchTask(task_id))
  );

  server.tool(
    "dispatch_ready",
    "Start every backlog task whose dependencies are satisfied.",
    {},
    async () => {
      await sweep();
      return text("Sweep complete.");
    }
  );

  server.tool(
    "create_schedule",
    "Schedule a recurring instruction for the orchestrator (cron syntax).",
    { name: z.string(), cron_expr: z.string().describe("Standard cron, e.g. '0 7 * * *' = daily 07:00"), prompt: z.string() },
    async ({ name, cron_expr, prompt }) => {
      const schedule = await db.schedule.create({ data: { name, cronExpr: cron_expr, prompt } });
      registerJob(schedule.id, cron_expr, prompt);
      return text(`Scheduled "${name}" (${cron_expr}). id=${schedule.id}`);
    }
  );

  server.tool("list_schedules", "List scheduled recurring instructions.", {}, async () =>
    text(await db.schedule.findMany())
  );

  server.tool(
    "cancel_schedule",
    "Disable a scheduled instruction permanently.",
    { schedule_id: z.string() },
    async ({ schedule_id }) => {
      await db.schedule.update({ where: { id: schedule_id }, data: { enabled: false } }).catch(() => null);
      jobs.get(schedule_id)?.stop();
      jobs.delete(schedule_id);
      return text("Cancelled.");
    }
  );

  return server;
}

function registerJob(id: string, cronExpr: string, prompt: string) {
  jobs.get(id)?.stop();
  const job = new Cron(cronExpr).schedule(() => {
    void db.schedule
      .update({ where: { id }, data: { lastRunAt: new Date() } })
      .then(() => orchestratorSay(prompt))
      .catch((e) => console.error("[schedule]", id, e));
  });
  jobs.set(id, job);
}

async function bootJobs() {
  const schedules = await db.schedule.findMany({ where: { enabled: true } });
  for (const s of schedules) registerJob(s.id, s.cronExpr, s.prompt);
  console.log(`[mcp] ${schedules.length} schedule(s) active`);
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => void transport.close());
  try {
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] error", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

app.get("/mcp", (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "stateless server: POST only" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, async () => {
  console.log(`[mcp] mission-control MCP listening on http://localhost:${PORT}/mcp`);
  await bootJobs().catch(console.error);
});

// keep randomUUID import used for potential future stateful mode
void randomUUID;
