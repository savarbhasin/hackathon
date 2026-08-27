import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Cron } from "croner";
import {
  durableBoard,
  durableTask,
  durableCreateMission,
  durableCreateTask,
  durableMarkDone,
  durableCreateDoc,
  durableUpdateDoc,
  durableSaveDocument,
  durableListDocs,
  durableGetDoc,
  durableCreateSchedule,
  durableListSchedules,
  durableCancelSchedule,
  durableDispatchTask,
  durableSweep,
} from "../src/lib/mcp-durable";


function text(t: unknown) {
  return { content: [{ type: "text" as const, text: typeof t === "string" ? t : JSON.stringify(t) }] };
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

export function buildServer(): McpServer {
  const server = new McpServer({ name: "mission-control", version: "0.1.0" });

  server.tool(
    "mark_done",
    "Signal that your assigned task is complete. Call this exactly once when work is finished. After calling it, stop immediately without using another tool or writing more output.",
    {
      task_id: z.string().describe("The TASK_ID given in your assignment"),
      summary: z
        .string()
        .describe("A concise completion report in 2 to 4 factual sentences stating what you did and the outcome"),
      handoff: z.any().optional().describe("Optional explicit context for downstream successors"),
    },
    async ({ task_id, summary, handoff }) => {
      const result = await durableMarkDone({ taskId: task_id, summary, handoff });
      if (result?.kind === "not_found") return text(`Unknown task_id ${task_id}`);
      if (result?.kind === "conflict" || result?.kind === "invalid_state") return text(`Could not record completion: ${result.reason ?? result.kind}`);
      return text("Recorded. Stop immediately. Do not call another tool or write any more output.");
    }
  );

  server.tool(
    "list_board",
    "Current state of all missions and tasks on the kanban board.",
    {},
    async () => text(await durableBoard())
  );

  server.tool(
    "get_task",
    "Full detail of one task including its recent event log.",
    { task_id: z.string() },
    async ({ task_id }) => text((await durableTask(task_id)) ?? `No task ${task_id}`)
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
      const doc = await durableCreateDoc({ taskId: task_id, title, content, kind });
      if (doc?.kind === "not_found") return text(`Unknown task_id ${task_id}`);
      if (doc?.kind === "conflict") return text(`Could not create document: ${doc.reason ?? doc.kind}`);
      return text(`Document created. id=${doc?.id ?? doc?._id} title="${doc?.title ?? title}" kind=${doc?.kind ?? kind}`);
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
      const doc = await durableUpdateDoc({ taskId: task_id, docId: doc_id, title, content });
      if (doc?.kind === "not_found") return text(`No document ${doc_id} belongs to task ${task_id}`);
      if (doc?.kind === "conflict") return text(`Could not update document: ${doc.reason ?? doc.kind}`);
      return text(`Document updated. id=${doc?.id ?? doc?._id} title="${doc?.title ?? title ?? ""}"`);
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
      const doc = await durableSaveDocument(title, content);
      if (doc?.kind === "conflict" || doc?.kind === "not_found") return text(`Could not save document: ${doc.reason ?? doc.kind}`);
      return text(`Document saved. id=${doc?.id ?? doc?._id} title="${doc?.title ?? title}"`);
    }
  );

  server.tool(
    "list_docs",
    "List saved agent documents with their mission and task names.",
    {},
    async () => text(await durableListDocs())
  );

  server.tool(
    "get_doc",
    "Read one saved agent document.",
    { doc_id: z.string() },
    async ({ doc_id }) => text((await durableGetDoc(doc_id)) ?? `No document ${doc_id}`)
  );

  server.tool(
    "create_mission",
    "Create a mission (a goal that will be broken into tasks). Returns the mission id.",
    { title: z.string(), goal: z.string().describe("What success looks like") },
    async ({ title, goal }) => {
      const mission = await durableCreateMission(title, goal);
      if (mission?.kind === "conflict" || mission?.kind === "not_found") return text(`Could not create mission: ${mission.reason ?? mission.kind}`);
      return text(`Mission created. id=${mission?.id ?? mission?._id} title="${mission?.title ?? title}"`);
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
      const task = await durableCreateTask({ missionId: mission_id, title, detail, role, dependsOn: depends_on });
      if (task?.kind === "invalid_role") return text(`Unknown or disabled agent "${role}". Use an agent id exactly as listed in the Available agents roster.`);
      if (task?.kind === "not_found" || task?.kind === "conflict") return text(task.reason ?? task.kind);
      return text(`Task created. id=${task?.id ?? task?._id} column=${task?.column ?? "backlog"}`);
    }
  );

  server.tool(
    "dispatch_task",
    "Start an agent on a backlog task immediately, even if dependencies are unmet.",
    { task_id: z.string() },
    async ({ task_id }) => text(await durableDispatchTask(task_id))
  );

  server.tool(
    "dispatch_ready",
    "Start every backlog task whose dependencies are satisfied.",
    {},
    async () => {
      await durableSweep();
      return text("Sweep complete.");
    }
  );

  server.tool(
    "create_schedule",
    "Schedule a recurring instruction for the orchestrator (cron syntax).",
    { name: z.string(), cron_expr: z.string().describe("Standard cron, e.g. '0 7 * * *' = daily 07:00"), prompt: z.string() },
    async ({ name, cron_expr, prompt }, extra) => {
      const cronExpr = cron_expr.trim();
      const validationError = cronValidationError(cronExpr);
      if (validationError) return text(`Invalid cron expression: ${validationError}`);

      try {
        const schedule = await durableCreateSchedule({
          name,
          cronExpr,
          prompt,
          requestId: extra.requestId,
          sessionId: extra.sessionId,
        });
        const scheduleId = schedule._id;
        const schedulerId = schedule.schedulerId;
        const tombstoned = schedule.deletedAt != null;
        return text(tombstoned
          ? `Schedule already exists and is cancelled. id=${scheduleId} scheduler=${schedulerId} enabled=false sync=${schedule.syncState}`
          : `Scheduled "${name}" (${cronExpr}). id=${scheduleId} scheduler=${schedulerId} enabled=${schedule.enabled} sync=${schedule.syncState}`);
      } catch (error) {
        return text(`Could not create schedule: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  server.tool("list_schedules", "List scheduled recurring instructions.", {}, async () => {
    try {
      return text(await durableListSchedules());
    } catch (error) {
      return text(`Could not list schedules: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.tool(
    "cancel_schedule",
    "Disable a scheduled instruction permanently.",
    { schedule_id: z.string() },
    async ({ schedule_id }) => {
      try {
        const result = await durableCancelSchedule(schedule_id);
        const outcome = result?.outcome ?? "deleted";
        if (outcome === "not_found") return text(`Schedule ${schedule_id} is already cancelled or missing.`);
        return text(`Cancelled schedule. id=${schedule_id} scheduler=${result?.schedulerId ?? "unknown"} outcome=${outcome}. Worker reconciliation will remove the scheduler.`);
      } catch (error) {
        return text(`Could not cancel schedule ${schedule_id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  );

  return server;
}
