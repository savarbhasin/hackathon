import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Cron } from "croner";
import { db } from "../src/lib/db";
import { getAgentDefinition } from "../src/lib/agents";
import { dispatchTask, getBoard, sweep } from "../src/lib/engine";
import { tf } from "../src/lib/tf";
import { runScheduleNow } from "../src/lib/schedule-runner";
import { appendTaskEvent } from "../src/lib/task-events";
import { dependencyIds, findDependencyCycle } from "../src/lib/task-graph";

const PORT = Number(process.env.MCP_PORT ?? 3100);
const HOST = process.env.MCP_HOST?.trim() || "127.0.0.1";
const NEW_TASK_NODE = "__new_task__";

const jobs = new Map<string, Cron>();

function text(t: unknown) {
  return { content: [{ type: "text" as const, text: typeof t === "string" ? t : JSON.stringify(t) }] };
}

async function validateTaskDependencies(missionId: string, dependsOn: string[]): Promise<string | null> {
  if (new Set(dependsOn).size !== dependsOn.length) {
    return "depends_on must not contain duplicate task IDs.";
  }

  const mission = await db.mission.findUnique({ where: { id: missionId }, select: { id: true } });
  if (!mission) return `Unknown mission_id ${missionId}`;

  if (dependsOn.length > 0) {
    const referenced = await db.task.findMany({
      where: { id: { in: dependsOn } },
      select: { id: true, missionId: true },
    });
    const byId = new Map(referenced.map((task) => [task.id, task]));
    const missing = dependsOn.filter((id) => !byId.has(id));
    if (missing.length > 0) return `Unknown depends_on task ID(s): ${missing.join(", ")}`;

    const wrongMission = dependsOn.filter((id) => byId.get(id)?.missionId !== missionId);
    if (wrongMission.length > 0) {
      return `depends_on task ID(s) belong to another mission: ${wrongMission.join(", ")}`;
    }
  }

  const existing = await db.task.findMany({
    where: { missionId },
    select: { id: true, dependsOn: true },
  });
  const cycle = findDependencyCycle([
    ...existing.map((task) => ({ id: task.id, dependsOn: dependencyIds(task.dependsOn) })),
    { id: NEW_TASK_NODE, dependsOn },
  ]);
  if (cycle) {
    const readableCycle = cycle.map((id) => (id === NEW_TASK_NODE ? "new task" : id));
    return `Dependency graph would be cyclic: ${readableCycle.join(" -> ")}`;
  }

  return null;
}

function cronValidationError(cronExpr: string): string | null {
  const expression = cronExpr.trim();
  const partCount = expression.match(/\S+/g)?.length ?? 0;
  if (!expression.startsWith("@") && (partCount < 5 || partCount > 7)) {
    return "cron expression must contain five, six, or seven fields";
  }

  try {
    new Cron(expression).stop();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mission-control", version: "0.1.0" });

  server.tool(
    "mark_done",
    "Signal that your assigned task is complete. Call this exactly once when work is finished. After calling it, stop immediately without using another tool or writing more output.",
    {
      task_id: z.string().describe("The TASK_ID given in your assignment"),
      summary: z
        .string()
        .describe("A concise completion report in 2 to 4 factual sentences stating what you did and the outcome"),
    },
    async ({ task_id, summary }) => {
      const existing = await db.task.findUnique({ where: { id: task_id } });
      if (!existing) return text(`Unknown task_id ${task_id}`);
      const sessionId = existing.sessionId;
      await db.task.update({
        where: { id: task_id },
        data: { output: summary.trim() },
      });
      await appendTaskEvent(task_id, "specialist.mark_done", { summary: summary.trim() });
      if (sessionId) {
        try {
          await tf().sessions.cancel(sessionId);
        } catch (error) {
          console.error("[mark_done] failed to stop session", sessionId, error);
        }
      }
      return text("Recorded. Stop immediately. Do not call another tool or write any more output.");
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
    "create_doc",
    "Create a Markdown document linked to your assigned task and mission. Use kind=handoff for substantial output needed by any downstream successor; use artifact only when no successor needs the document.",
    {
      task_id: z.string().describe("The TASK_ID given in your assignment"),
      title: z.string().min(1).max(160),
      content: z.string().min(1).describe("The complete document in Markdown"),
      kind: z
        .enum(["artifact", "handoff"])
        .default("artifact")
        .describe("Required decision: use handoff when any successor needs this document as input; use artifact only for durable material that no successor needs"),
    },
    async ({ task_id, title, content, kind }) => {
      const task = await db.task.findUnique({ where: { id: task_id } });
      if (!task) return text(`Unknown task_id ${task_id}`);
      const doc = await db.document.create({
        data: {
          title,
          content,
          kind,
          authorRole: task.role,
          missionId: task.missionId,
          taskId: task.id,
        },
      });
      await appendTaskEvent(task.id, "activity.document_created", {
        title: `Created document: ${doc.title}`,
        documentId: doc.id,
        kind: doc.kind,
      });
      return text(`Document created. id=${doc.id} title="${doc.title}" kind=${doc.kind}`);
    }
  );

  server.tool(
    "update_doc",
    "Replace the title or Markdown content of a document created by your task.",
    {
      task_id: z.string().describe("The TASK_ID given in your assignment"),
      doc_id: z.string(),
      title: z.string().min(1).max(160).optional(),
      content: z.string().min(1).optional(),
    },
    async ({ task_id, doc_id, title, content }) => {
      if (title == null && content == null) return text("Provide title or content.");
      const existing = await db.document.findFirst({ where: { id: doc_id, taskId: task_id } });
      if (!existing) return text(`No document ${doc_id} belongs to task ${task_id}`);
      const doc = await db.document.update({
        where: { id: doc_id },
        data: { title, content },
      });
      await appendTaskEvent(task_id, "activity.document_updated", {
        title: `Updated document: ${doc.title}`,
        documentId: doc.id,
        kind: doc.kind,
      });
      return text(`Document updated. id=${doc.id} title="${doc.title}"`);
    }
  );

  server.tool(
    "save_document",
    "Create or update a Markdown document by title (orchestrator-level, not tied to a task).",
    {
      title: z.string().min(1).max(160),
      content: z.string().min(1).describe("The complete document in Markdown"),
    },
    async ({ title, content }) => {
      const existing = await db.document.findFirst({ where: { title } });
      const doc = existing
        ? await db.document.update({ where: { id: existing.id }, data: { content } })
        : await db.document.create({ data: { title, content, authorRole: "squad-lead" } });
      return text(`Document saved. id=${doc.id} title="${doc.title}"`);
    }
  );

  server.tool(
    "list_docs",
    "List saved agent documents with their mission and task names.",
    {},
    async () =>
      text(
        await db.document.findMany({
          include: {
            mission: { select: { title: true } },
            task: { select: { title: true, role: true } },
          },
          orderBy: { updatedAt: "desc" },
        })
      )
  );

  server.tool(
    "get_doc",
    "Read one saved agent document.",
    { doc_id: z.string() },
    async ({ doc_id }) => {
      const doc = await db.document.findUnique({
        where: { id: doc_id },
        include: {
          mission: { select: { title: true } },
          task: { select: { title: true, role: true } },
        },
      });
      return text(doc ?? `No document ${doc_id}`);
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
    "Create one self-contained task on a mission's kanban board. Create the full dependency graph before calling dispatch_ready.",
    {
      mission_id: z.string(),
      title: z.string(),
      detail: z.string().describe("Self-contained contract covering outcome, inputs, bounded work, exact deliverable, constraints, done checks, and downstream handoff requirements"),
      role: z
        .string()
        .min(1)
        .describe("Agent id from the Available agents roster in your context"),
      depends_on: z.array(z.string()).default([]).describe("Same-mission predecessor task IDs whose output is required. Leave empty for work that can start independently"),
    },
    async ({ mission_id, title, detail, role, depends_on }) => {
      const profile = await getAgentDefinition(role);
      if (!profile?.enabled) {
        return text(`Unknown or disabled agent "${role}". Use an agent id exactly as listed in the Available agents roster.`);
      }
      const dependencyError = await validateTaskDependencies(mission_id, depends_on);
      if (dependencyError) return text(dependencyError);

      const count = await db.task.count({ where: { missionId: mission_id } });
      const task = await db.task.create({
        data: {
          missionId: mission_id,
          title,
          detail,
          role: profile.slug,
          agentPrompt: null,
          dependsOn: JSON.stringify(depends_on),
          position: count,
        },
      });
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
      const cronExpr = cron_expr.trim();
      const validationError = cronValidationError(cronExpr);
      if (validationError) return text(`Invalid cron expression: ${validationError}`);

      const schedule = await db.schedule.create({ data: { name, cronExpr, prompt } });
      registerJob(schedule.id, cronExpr);
      return text(`Scheduled "${name}" (${cronExpr}). id=${schedule.id}`);
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

function registerJob(id: string, cronExpr: string) {
  const validationError = cronValidationError(cronExpr);
  if (validationError) throw new Error(`Invalid cron expression: ${validationError}`);

  const job = new Cron(cronExpr).schedule(() => {
    void runScheduleNow(id).catch((error) => {
      if (error instanceof Error && error.name === "ScheduleDisabledError") {
        jobs.get(id)?.stop();
        jobs.delete(id);
        return;
      }
      console.error("[schedule]", id, error);
    });
  });
  jobs.get(id)?.stop();
  jobs.set(id, job);
}

async function bootJobs() {
  const schedules = await db.schedule.findMany({ where: { enabled: true } });
  let active = 0;
  for (const schedule of schedules) {
    try {
      registerJob(schedule.id, schedule.cronExpr);
      active += 1;
    } catch (error) {
      console.error(`[schedule] failed to register ${schedule.id}`, error);
    }
  }
  console.log(`[mcp] ${active}/${schedules.length} schedule(s) active`);
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

app.listen(PORT, HOST, async () => {
  console.log(`[mcp] mission-control MCP listening on http://${HOST}:${PORT}/mcp`);
  await bootJobs().catch(console.error);
});
