import { isEventDelta, mergeEventDelta, TrueForge } from "@truefoundry/trueforge-sdk";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { TITLE_MODEL } from "./fleet";

const TITLE_INSTRUCTIONS = `You generate concise conversation titles. Return only the title, with no quotation marks, markdown, explanation, or punctuation at the end. Use 3 to 8 words and describe the user's request accurately.`;

export function fallbackConversationTitle(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return "New conversation";
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 69)}...`;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function titleText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value
    .replace(/[\r\n]+/g, " ")
    .replace(/^['"`\s]+|['"`\s]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return title || null;
}

/** Ask the configured lightweight title model for a display title. */
export async function generateConversationTitle(client: TrueForge, message: string): Promise<string | null> {
  const { data: session } = await client.sessions.create({
    agent: {
      spec: {
        model: { name: TITLE_MODEL },
        instructions: TITLE_INSTRUCTIONS,
        config: {
          sandbox: { enabled: false },
          dynamicSubAgents: { enabled: false },
          generativeUi: { enabled: false },
        },
      } as TrueForgeApi.AgentSpec,
    },
  });
  const stream = await client.sessions.createTurnStream(session.id, {
    input: [{ type: "user.message", content: message.slice(0, 4_000) }],
    previousTurnId: "none" as never,
  });
  const messages = new Map<string, RecordValue>();
  let fallback = "";
  let terminal: string | null = null;
  for await (const metadata of stream.withMetadata()) {
    const event = record(metadata.data);
    if (!event) continue;
    if (event.type === "model.message" && typeof event.id === "string") {
      messages.set(event.id, event);
    } else if (isEventDelta(metadata.data as never)) {
      if (typeof event.id === "string") {
        const base = messages.get(event.id);
        if (base) mergeEventDelta(base as never, metadata.data as never);
      }
      if (event.threadId === "main" && typeof event.content === "string") fallback += event.content;
    }
    if (event.type === "turn.done") {
      const state = record(event.state);
      const output = record(state?.output);
      terminal = titleText(output?.content);
    }
  }
  if (terminal) return terminal;
  const merged = [...messages.values()]
    .filter((item) => item.threadId === undefined || item.threadId === "main")
    .map((item) => typeof item.content === "string" ? item.content : "")
    .join("");
  return titleText(merged || fallback);
}
