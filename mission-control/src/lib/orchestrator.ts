import { db } from "./db";
import { tf } from "./tf";
import { ORCHESTRATOR_SPEC } from "./fleet";
import { isEventDelta, mergeEventDelta } from "@truefoundry/trueforge-sdk";

export async function ensureOrchestratorSession(): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: "orchestrator_session_id" } });
  if (row) {
    try {
      await tf().sessions.get(row.value);
      return row.value;
    } catch {
      /* stale session — recreate */
    }
  }
  const { data: session } = await tf().sessions.create({
    agent: { spec: ORCHESTRATOR_SPEC as never },
  });
  await db.setting.upsert({
    where: { key: "orchestrator_session_id" },
    update: { value: session.id },
    create: { key: "orchestrator_session_id", value: session.id },
  });
  return session.id;
}

export interface ChatEvent {
  kind: "delta" | "tool" | "status" | "done";
  text?: string;
  name?: string;
}

export async function* runOrchestratorTurn(
  message: string
): AsyncGenerator<ChatEvent> {
  const sessionId = await ensureOrchestratorSession();
  const stream = await tf().sessions.createTurnStream(sessionId, {
    input: [{ type: "user.message", content: message }],
  });

  let finalText = "";
  let status = "unknown";
  const events = new Map<string, Record<string, any>>();
  const seenTools = new Set<string>();

  for await (const { data: event } of stream.withMetadata()) {
    const ev = event as Record<string, any>;

    if (isEventDelta(event)) {
      const base = events.get(ev.id);
      if (base) {
        mergeEventDelta(base as never, ev as never);
        for (const c of (base.toolCalls ?? []) as Array<{ function?: { name?: string } }>) {
          if (c.function?.name && !seenTools.has(c.function.name)) {
            seenTools.add(c.function.name);
            yield { kind: "tool", name: c.function.name };
          }
        }
      }
      continue;
    }

    switch (ev.type) {
      case "model.message": {
        events.set(ev.id, ev);
        const calls = (ev.toolCalls ?? []) as Array<{ function?: { name?: string } }>;
        for (const c of calls) {
          if (c.function?.name && !seenTools.has(c.function.name)) {
            seenTools.add(c.function.name);
            yield { kind: "tool", name: c.function.name };
          }
        }
        break;
      }
      case "model.message.delta":
        if (ev.threadId === "main" && ev.content) yield { kind: "delta", text: ev.content };
        break;
      case "tool.approval_required":
        yield { kind: "status", text: "waiting for approval on a specialist card" };
        break;
      case "turn.done":
        status = ev.state?.status ?? "unknown";
        finalText = ev.state?.output?.content ?? "";
        {
          const m = ev.state?.metrics;
          if (m) {
            const tokens = m.totalTokens ?? m.total_tokens;
            const cost = m.totalCostInUsd ?? m.total_cost_in_usd ?? 0;
            yield { kind: "status", text: `${tokens ?? "?"} tokens · $${Number(cost).toFixed(4)}` };
          }
        }
        break;
    }
  }

  yield { kind: "done", text: finalText, name: status };
}

export async function orchestratorSay(prompt: string): Promise<string> {
  let finalText = "";
  for await (const ev of runOrchestratorTurn(prompt)) {
    if (ev.kind === "done") finalText = ev.text ?? "";
  }
  return finalText;
}
