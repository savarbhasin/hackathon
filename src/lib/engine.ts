import { db } from "./db";
import { tf } from "./tf";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";
import { appendTaskEvent } from "./task-events";
import { dependencyIds } from "./task-graph";

export type Column = "backlog" | "working" | "blocked" | "approval" | "settled";

const PAYLOAD_CAP = 4000;

function truncate(s: string, cap = PAYLOAD_CAP): string {
  return s.length <= cap ? s : s.slice(0, cap) + "…[truncated]";
}

interface PendingAction {
  type: string;
  threadId?: string | null;
  toolCalls: Array<{ id: string; sourceEventId?: string }>;
}

interface PumpToolCall {
  id: string;
  toolInfo?: { name?: string };
  function?: { name?: string; arguments?: string };
}

interface PumpEvent extends Record<string, unknown> {
  id: string;
  type: string;
  turnId?: string;
  toolCalls?: PumpToolCall[];
  state?: {
    status?: string;
    requiredActions?: PendingAction[];
    required_actions?: PendingAction[];
    output?: { content?: string; text?: string } | null;
    reason?: string;
    message?: string;
  };
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
  dependencies: Array<{
    id: string;
    title: string;
    role: string;
    column: string;
    summary: string | null;
    documents: Array<{ id: string; title: string }>;
  }>;
  successors: Array<{ id: string; title: string; role: string }>;
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

  if (input.dependencies.length === 0) {
    parts.push("", "PREDECESSORS: None. You may begin without waiting for another task.");
  } else {
    parts.push("", "PREDECESSOR CONTEXT:");
    for (const dependency of input.dependencies) {
      parts.push(`- ${dependency.title} [${dependency.role}] (TASK_ID: ${dependency.id}, STATUS: ${dependency.column})`);
      if (dependency.summary) parts.push(`  Completion summary: ${dependency.summary}`);
      if (dependency.documents.length === 0) {
        parts.push("  Handoff documents: none attached.");
      } else {
        parts.push("  Handoff documents:");
        for (const document of dependency.documents) {
          parts.push(`  - ${document.title} (DOC_ID: ${document.id})`);
        }
      }
    }
    const documentCount = input.dependencies.reduce(
      (count, dependency) => count + dependency.documents.length,
      0
    );
    if (documentCount > 0) {
      parts.push("Required startup step: call get_doc for every DOC_ID above before doing dependent work.");
    } else {
      parts.push("No handoff document was attached. Use the completion summaries only for limited context. If your assignment requires missing predecessor material, ask one precise question instead of inventing it.");
    }
  }

  if (input.successors.length > 0) {
    parts.push("", "DOWNSTREAM SUCCESSORS THAT DEPEND ON YOUR OUTPUT:");
    for (const successor of input.successors) {
      parts.push(`- ${successor.title} [${successor.role}] (TASK_ID: ${successor.id})`);
    }
    parts.push(
      "Before mark_done, create a self-contained document with kind=\"handoff\" if these successors need substantial context, evidence, decisions, or finished material from you. Verify the create_doc response says kind=handoff and include its DOC_ID in your completion summary."
    );
  } else {
    parts.push(
      "",
      "DOWNSTREAM SUCCESSORS: None are recorded at dispatch time. Follow any downstream handoff requirement in YOUR ASSIGNMENT. Otherwise use kind=\"artifact\" for durable human-readable work."
    );
  }

  parts.push(
    "",
    "EXECUTION RULES:",
    "- Treat the mission as context and YOUR ASSIGNMENT as the exact scope.",
    "- Use supplied inputs and readable handoff documents before asking the user for information.",
    "- Do not invent missing facts, IDs, document contents, tool results, or completed actions.",
    "- If a required tool or input remains unavailable after safe checks, ask one precise question that explains the blocker.",
    "- Call mark_done exactly once, only after the deliverable exists and required checks or approval-gated actions have reached a real outcome.",
    "",
    "Begin work now."
  );
  return parts.join("\n");
}

async function predecessorContext(missionId: string, dependsOn: string[]) {
  if (dependsOn.length === 0) return [];
  const deps = await db.task.findMany({
    where: { missionId, id: { in: dependsOn } },
    include: {
      documents: {
        where: { kind: "handoff" },
        select: { id: true, title: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  const byId = new Map(deps.map((dependency) => [dependency.id, dependency]));
  return dependsOn.flatMap((id) => {
    const dependency = byId.get(id);
    if (!dependency) return [];
    return [{
      id: dependency.id,
      title: dependency.title,
      role: dependency.role,
      column: dependency.column,
      summary: dependency.output ? truncate(dependency.output, 1200) : null,
      documents: dependency.column === "settled" ? dependency.documents : [],
    }];
  });
}

async function successorContext(taskId: string, missionId: string) {
  const candidates = await db.task.findMany({
    where: { missionId, id: { not: taskId } },
    select: { id: true, title: true, role: true, dependsOn: true },
    orderBy: { position: "asc" },
  });
  return candidates
    .filter((candidate) => dependencyIds(candidate.dependsOn).includes(taskId))
    .map(({ id, title, role }) => ({ id, title, role }));
}

export async function dispatchTask(taskId: string): Promise<{ ok: boolean; reason?: string }> {
  const task = await db.task.findUnique({ where: { id: taskId }, include: { mission: true } });
  if (!task) return { ok: false, reason: "not_found" };
  if (task.sessionId) return { ok: false, reason: "already_dispatched" };
  if (task.column !== "backlog") return { ok: false, reason: `column=${task.column}` };

  const claim = await db.task.updateMany({
    where: { id: taskId, column: "backlog", sessionId: null },
    data: {
      column: "working",
      turnId: null,
      pendingActions: null,
      handoff: null,
      output: null,
      error: null,
    },
  });
  if (claim.count === 0) return { ok: false, reason: "lost_race" };

  let remoteSessionId: string | null = null;
  try {
    const { data: session } = await tf().sessions.create({ agent: { name: task.role } });
    remoteSessionId = session.id;

    const dependsOn = dependencyIds(task.dependsOn);
    const [dependencies, successors] = await Promise.all([
      predecessorContext(task.missionId, dependsOn),
      successorContext(task.id, task.missionId),
    ]);
    const kickoff = buildKickoff({
      missionTitle: task.mission.title,
      missionGoal: task.mission.goal,
      taskTitle: task.title,
      taskDetail: task.detail,
      taskId: task.id,
      dependencies,
      successors,
    });

    await db.task.update({ where: { id: taskId }, data: { sessionId: session.id } });
    await appendTaskEvent(taskId, "activity.started", {
      title: "Agent started work",
      role: task.role,
    });
    void runPump(taskId, session.id, [{ type: "user.message", content: kickoff }]);
    return { ok: true };
  } catch (error) {
    const message = truncate(String(error), 500);
    const recovered = await db.task.updateMany({
      where: {
        id: taskId,
        column: "working",
        OR: [{ sessionId: null }, ...(remoteSessionId ? [{ sessionId: remoteSessionId }] : [])],
      },
      data: {
        column: "backlog",
        sessionId: null,
        turnId: null,
        pendingActions: null,
        error: `dispatch failed: ${message}`,
      },
    });

    if (remoteSessionId) await deleteRemoteSession(remoteSessionId);
    if (recovered.count > 0) {
      try {
        await appendTaskEvent(taskId, "activity.dispatch_failed", {
          title: "Agent dispatch failed",
          message,
        });
      } catch (eventError) {
        console.error("[dispatch] failed to record recovery event", taskId, eventError);
      }
    }
    return { ok: false, reason: "dispatch_failed" };
  }
}

async function deleteRemoteSession(sessionId: string) {
  try {
    await tf().sessions.delete(sessionId);
  } catch (error) {
    console.error("[dispatch] failed to delete remote session", sessionId, error);
  }
}

async function runPump(taskId: string, sessionId: string, input: Array<Record<string, unknown>>) {
  let providerStreamId: string | null = null;
  try {
    const stream = await tf().sessions.createTurnStream(sessionId, { input: input as never });
    const events = new Map<string, PumpEvent>();

    for await (const { data: event, id } of stream.withMetadata()) {
      if (id != null) providerStreamId = String(id);
      const ev = event as unknown as PumpEvent;
      const type = ev.type;

      if (isEventDelta(event)) {
        const base = events.get(ev.id);
        if (base) mergeEventDelta(base as never, ev as never);
        continue;
      }

      if (!events.has(ev.id)) {
        await appendTaskEvent(taskId, type, {
          ...ev,
          providerStreamId,
        });
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
          await handleDone(taskId, sessionId, ev, events);
          break;
      }
    }
  } catch (err) {
    const message = String(err).slice(0, 500);
    await setColumn(taskId, "blocked", { error: message });
    await appendTaskEvent(taskId, "pump.error", { message, providerStreamId });
    await appendTaskEvent(taskId, "activity.failed", {
      title: "Agent run failed",
      message,
    });
  }
}

async function handleDone(
  taskId: string,
  sessionId: string,
  done: PumpEvent,
  events: Map<string, PumpEvent>
) {
  const status = done.state?.status;
  const requiredActions: PendingAction[] =
    done.state?.requiredActions ?? done.state?.required_actions ?? [];

  if (status === "done" && requiredActions.length === 0) {
    const fallbackOutput =
      done.state?.output?.content ??
      done.state?.output?.text ??
      null;
    const current = await db.task.findUnique({
      where: { id: taskId },
      select: { output: true },
    });
    const recordedSummary = current?.output?.trim() ? current.output : null;
    const output = recordedSummary ?? (fallbackOutput ? truncate(String(fallbackOutput), 8000) : null);
    await db.task.update({
      where: { id: taskId },
      data: { column: "settled", output, error: null },
    });
    await appendTaskEvent(taskId, "activity.completed", {
      title: "Task completed",
      summary: output,
    });
    await sweep();
    return;
  }

  if (status === "cancelled") {
    await db.task.update({
      where: { id: taskId },
      data: {
        column: "backlog",
        sessionId: null,
        turnId: null,
        pendingActions: null,
        handoff: null,
        output: null,
        error: `cancelled: ${done.state?.reason ?? ""}`,
      },
    });
    await appendTaskEvent(taskId, "activity.cancelled", {
      title: "Agent run cancelled",
      reason: done.state?.reason ?? null,
    });
    return;
  }

  if (status === "error") {
    const message = truncate(String(done.state?.message ?? "unknown"));
    await setColumn(taskId, "blocked", { error: message });
    await appendTaskEvent(taskId, "activity.failed", {
      title: "Agent run failed",
      message,
    });
    return;
  }

  // paused — persist pending actions for the drawer / resume endpoints
  const enriched = requiredActions.map((ra) => ({
    ...ra,
    calls: ra.toolCalls.map((ref) => {
      const msg = ref.sourceEventId ? events.get(ref.sourceEventId) : undefined;
      const call = msg?.toolCalls?.find((toolCall) => toolCall.id === ref.id);
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
  await appendTaskEvent(taskId, "pause.pending", enriched);
  const waitingForApproval = enriched.some((action) => action.type === "tool.approval_required");
  await appendTaskEvent(
    taskId,
    waitingForApproval ? "activity.waiting_approval" : "activity.waiting_response",
    {
      title: waitingForApproval ? "Waiting for approval" : "Waiting for a response",
      tools: activityToolNames(enriched),
    }
  );
  await db.task.update({
    where: { id: taskId },
    data: { pendingActions: JSON.stringify(enriched) },
  });
  await setColumn(taskId, waitingForApproval ? "approval" : "blocked");
  void sessionId;
}

export async function sweep(): Promise<void> {
  const candidates = await db.task.findMany({ where: { column: "backlog" } });
  const ready: string[] = [];
  for (const t of candidates) {
    const deps = dependencyIds(t.dependsOn);
    if (deps.length === 0) {
      // auto-dispatch only tasks that were created as part of an active mission flow
      ready.push(t.id);
      continue;
    }
    const preds = await db.task.findMany({
      where: { missionId: t.missionId, id: { in: deps } },
    });
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

  const tools = activityToolNames(pending);
  if (decision.kind === "approve") {
    await appendTaskEvent(taskId, "activity.approval_resolved", {
      title: decision.allow ? "Approval granted" : "Approval denied",
      allowed: decision.allow,
      reason: decision.reason ?? null,
      tools,
    });
  } else {
    await appendTaskEvent(taskId, "activity.response_sent", {
      title: "Response sent to agent",
      tools,
    });
  }
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

function activityToolNames(actions: EnrichedAction[]): string[] {
  return [...new Set(actions.flatMap((action) => action.calls.map((call) => call.name).filter(Boolean)))] as string[];
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
