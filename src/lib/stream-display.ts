export interface StreamingMessagePart {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  state?: string;
}

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
