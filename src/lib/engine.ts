import { db } from "./db";
import { tf } from "./tf";
import { getRole } from "./fleet";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export type Column = "backlog" | "working" | "blocked" | "approval" | "settled";

const PAYLOAD_CAP = 4000;

function truncate(s: string, cap = PAYLOAD_CAP): string {
  return s.length <= cap ? s : s.slice(0, cap) + "…[truncated]";
}

async function logEvent(taskId: string, seq: number, type: string, payload: unknown) {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload ?? {});
  await db.taskEvent.create({
    data: { taskId, seq, type, payload: truncate(json) },
  });
}

interface PendingAction {
  type: string;
  threadId?: string | null;
  toolCalls: Array<{ id: string; sourceEventId?: string }>;
}

async function setColumn(taskId: string, column: Column, extra: Partial<{ turnId: string; error: string | null }> = {}) {
  await db.task.update({ where: { id: taskId }, data: { column, ...extra } });
}

export function buildKickoff(input: {
  missionTitle: string;
  missionGoal: string;
  taskTitle: string;
  taskDetail?: string | null;
  taskId: string;
  predecessors: Array<{ role: string; title: string; context: string }>;
}): string {
  const parts = [
    `MISSION: ${input.missionTitle}`,
    input.missionGoal,
    "",
    `YOUR ASSIGNMENT: ${input.taskTitle}`,
    input.taskDetail ?? "(no additional detail)",
    "",
    `TASK_ID: ${input.taskId}`,
  ];
  if (input.predecessors.length > 0) {
    parts.push("", "CONTEXT FROM COMPLETED PREDECESSORS:");
    for (const p of input.predecessors) {
      parts.push(`← [${p.role}] ${p.title}: ${p.context}`);
    }
  }
  parts.push("", "Begin work now. When finished, call mark_done.");
  return parts.join("\n");
}

async function predecessorContexts(dependsOn: string[]) {
  if (dependsOn.length === 0) return [];
  const deps = await db.task.findMany({ where: { id: { in: dependsOn } } });
  return deps
    .filter((d) => d.column === "settled")
    .map((d) => ({
      role: d.role,
      title: d.title,
      context: d.handoff ?? d.output ?? "(no handoff recorded)",
    }));
}

export async function dispatchTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const task = await db.task.findUnique({ where: { id: taskId }, include: { mission: true } });
  if (!task) return { ok: false, reason: "not_found" };
  if (task.sessionId) return { ok: false, reason: "already_dispatched" };
  if (task.column !== "backlog") return { ok: false, reason: `column=${task.column}` };

  const claim = await db.task.updateMany({
    where: { id: taskId, sessionId: null },
    data: { column: "working", pendingActions: null },
  });
  if (claim.count === 0) return { ok: false, reason: "lost_race" };

  const role = getRole(task.role);
  const { data: session } = await tf().sessions.create({ agent: { spec: role.spec as never } });

  const dependsOn = JSON.parse(task.dependsOn || "[]") as string[];
  const kickoff = buildKickoff({
    missionTitle: task.mission.title,
    missionGoal: task.mission.goal,
    taskTitle: task.title,
    taskDetail: task.detail,
    taskId: task.id,
    predecessors: await predecessorContexts(dependsOn),
  });

  await db.task.update({ where: { id: taskId }, data: { sessionId: session.id } });
  void runPump(taskId, session.id, [{ type: "user.message", content: kickoff }]);
  return { ok: true };
}

async function runPump(taskId: string, sessionId: string, input: Array<Record<string, unknown>>) {
  let lastSeq = 0;
  try {
    const stream = await tf().sessions.createTurnStream(sessionId, { input: input as never });
    const events = new Map<string, Record<string, unknown>>();

    for await (const { data: event, id } of stream.withMetadata()) {
      if (id != null) lastSeq = Number(id);
      const ev = event as Record<string, any>;
      const type = ev.type as string;

      if (isEventDelta(event)) {
        const base = events.get(ev.id);
        if (base) mergeEventDelta(base as never, ev as never);
        continue;
      }

      if (!events.has(ev.id)) {
        await logEvent(taskId, lastSeq, type, ev);
      }
      events.set(ev.id, ev);

      switch (type) {
        case "turn.created":
          await db.task.update({ where: { id: taskId }, data: { turnId: ev.turnId } });
          break;
        case "tool.approval_required":
          await setColumn(taskId, "approval");
          break;
        case "tool.response_required":
        case "mcp.auth_required":
          await setColumn(taskId, "blocked");
          break;
        case "turn.done":
          await handleDone(taskId, sessionId, ev, events, lastSeq);
          break;
      }
    }
  } catch (err) {
    await setColumn(taskId, "blocked", { error: String(err).slice(0, 500) });
    await logEvent(taskId, lastSeq + 1, "pump.error", { message: String(err) });
  }
}

async function handleDone(
  taskId: string,
  sessionId: string,
  done: Record<string, any>,
  events: Map<string, Record<string, unknown>>,
  lastSeq: number
) {
  const status = done.state?.status;
  const requiredActions: PendingAction[] =
    done.state?.requiredActions ?? done.state?.required_actions ?? [];

  if (status === "done" && requiredActions.length === 0) {
    const output =
      done.state?.output?.content ??
      done.state?.output?.text ??
      null;
    await db.task.update({
      where: { id: taskId },
      data: { column: "settled", output: output ? truncate(String(output), 8000) : null, error: null, lastSeq },
    });
    await sweep();
    return;
  }

  if (status === "cancelled") {
    await setColumn(taskId, "backlog", { error: `cancelled: ${done.state?.reason ?? ""}` });
    return;
  }

  if (status === "error") {
    await setColumn(taskId, "blocked", { error: truncate(String(done.state?.message ?? "unknown")) });
    return;
  }

  // paused — persist pending actions for the drawer / resume endpoints
  const enriched = requiredActions.map((ra) => ({
    ...ra,
    calls: ra.toolCalls.map((ref) => {
      const msg = ref.sourceEventId ? events.get(ref.sourceEventId) : undefined;
      const call = (msg?.toolCalls as Array<Record<string, any>> | undefined)?.find((tc) => tc.id === ref.id);
      let name: string | undefined = call ? (call.toolInfo?.name ?? call.function?.name) : undefined;
      let args = call?.function?.arguments;
      if ((!name || name === "call_tool") && args) {
        try {
          const parsed = JSON.parse(args) as { mcp_server?: string; tool_name?: string; input?: unknown };
          if (parsed.mcp_server && parsed.tool_name) {
            name = `${parsed.mcp_server}.${parsed.tool_name}`;
            args = JSON.stringify(parsed.input ?? parsed);
          }
        } catch {
          /* keep raw */
        }
      }
      return {
        id: ref.id,
        threadId: ra.threadId,
        name,
        args,
      };
    }),
  }));
  await logEvent(taskId, lastSeq + 1, "pause.pending", enriched);
  await db.task.update({ where: { id: taskId }, data: { pendingActions: JSON.stringify(enriched) } });
  await setColumn(taskId, enriched.some((a) => a.type === "tool.approval_required") ? "approval" : "blocked");
  void sessionId;
}

export async function sweep(): Promise<void> {
  const candidates = await db.task.findMany({ where: { column: "backlog" } });
  const ready: string[] = [];
  for (const t of candidates) {
    const deps = JSON.parse(t.dependsOn || "[]") as string[];
    if (deps.length === 0) {
      // auto-dispatch only tasks that were created as part of an active mission flow
      ready.push(t.id);
      continue;
    }
    const preds = await db.task.findMany({ where: { id: { in: deps } } });
    if (preds.length === deps.length && preds.every((p) => p.column === "settled")) ready.push(t.id);
  }
  for (const id of ready) await dispatchTask(id);
}

export async function resolvePause(
  taskId: string,
  decision: { kind: "approve"; allow: boolean; reason?: string } | { kind: "answer"; content: string }
): Promise<{ ok: boolean; reason?: string }> {
  const task = await db.task.findUnique({ where: { id: taskId } });
  if (!task?.sessionId) return { ok: false, reason: "no_session" };
  if (!task.pendingActions) return { ok: false, reason: "nothing_pending" };

  const pending = JSON.parse(task.pendingActions) as EnrichedAction[];
  const approvals: Array<Record<string, unknown>> = [];
  const responses: Array<Record<string, unknown>> = [];

  for (const action of pending) {
    for (const call of action.calls) {
      if (action.type === "tool.approval_required" && decision.kind === "approve") {
        approvals.push({
          type: "user.tool_approval",
          threadId: call.threadId,
          toolCallId: call.id,
          approval: decision.allow ? { status: "allow" } : { status: "deny", reason: decision.reason ?? "denied by user" },
        });
      }
      if (action.type === "tool.response_required" && decision.kind === "answer") {
        responses.push({ type: "user.tool_response", threadId: call.threadId, toolCallId: call.id, content: decision.content });
      }
    }
  }
  if (approvals.length === 0 && responses.length === 0) return { ok: false, reason: "decision_mismatch" };

  await db.task.update({ where: { id: taskId }, data: { pendingActions: null } });
  await setColumn(taskId, "working", { error: null });
  void runPumpResume(taskId, task.sessionId, [...approvals, ...responses]);
  return { ok: true };
}

interface EnrichedAction {
  type: string;
  threadId?: string | null;
  calls: Array<{ id: string; threadId?: string | null; name?: string; args?: string }>;
}

async function runPumpResume(taskId: string, sessionId: string, input: Array<Record<string, unknown>>) {
  return runPump(taskId, sessionId, input);
}

export async function getBoard() {
  const missions = await db.mission.findMany({
    include: { tasks: { orderBy: { position: "asc" } } },
    orderBy: { createdAt: "desc" },
  });
  return missions;
}
