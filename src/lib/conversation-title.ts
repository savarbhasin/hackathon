const CONVERSATION_TITLE_LENGTH = 20;

/** Use the normalized first user message as the permanent conversation title. */
export function fallbackConversationTitle(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (!singleLine) return "New conversation";
  return Array.from(singleLine).slice(0, CONVERSATION_TITLE_LENGTH).join("").trimEnd();
}
