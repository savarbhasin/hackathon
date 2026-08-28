export interface StreamingMessagePart {
  type?: string;
  text?: string;
  toolName?: string;
  state?: string;
}

/**
 * Text before the latest tool part is transient model narration. It remains
 * visible until the tool starts, then only text produced after that tool is
 * shown as the answer.
 */
export function visibleStreamText(parts: StreamingMessagePart[] | undefined, fallback: string): string {
  if (!parts) return fallback;
  let lastToolPart = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (typeof parts[index].toolName === "string") lastToolPart = index;
  }
  if (lastToolPart < 0) return fallback;
  return parts
    .slice(lastToolPart + 1)
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
}
