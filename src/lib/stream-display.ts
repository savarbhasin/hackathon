export interface StreamingMessagePart {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
}

export type StreamingMessageGroup =
  | { type: "text"; part: StreamingMessagePart }
  | { type: "tools"; parts: StreamingMessagePart[] };

/**
 * Keep every visible text/tool segment in provider order. The fallback is used
 * only for legacy durable messages or before the component exposes its parts.
 */
export function orderedStreamParts(
  parts: StreamingMessagePart[] | undefined,
  fallback: string,
): StreamingMessagePart[] {
  const visible = (parts ?? []).filter((part) =>
    part.type === "text" && typeof part.text === "string" && part.text.length > 0
    || typeof part.toolName === "string" && part.toolName.length > 0);
  if (visible.length > 0) return visible;
  return fallback ? [{ type: "text", text: fallback }] : [];
}

/** Merge only consecutive tool calls so narration remains in its exact place. */
export function groupStreamParts(parts: StreamingMessagePart[]): StreamingMessageGroup[] {
  const groups: StreamingMessageGroup[] = [];
  for (const part of parts) {
    if (part.type === "text" && part.text) {
      groups.push({ type: "text", part });
      continue;
    }
    if (!part.toolName) continue;
    const latest = groups[groups.length - 1];
    if (latest?.type === "tools") latest.parts.push(part);
    else groups.push({ type: "tools", parts: [part] });
  }
  return groups;
}
