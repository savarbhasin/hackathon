export interface SpecialistActivityToolCall {
  id: string;
  name: string;
}

export interface SpecialistActivityMessage {
  id: string;
  threadId?: string;
  content?: string;
  toolCalls: SpecialistActivityToolCall[];
}

export type SpecialistActivityUpdate =
  | {
      type: "activity.narration";
      operationSuffix: string;
      payload: { content: string; messageId: string };
    }
  | {
      type: "activity.tool";
      operationSuffix: string;
      payload: { name: string; phase: "started" | "completed"; toolCallId: string };
    };

/**
 * Turns cumulative, merged provider messages into durable semantic activity.
 * Each narration segment is frozen once its first tool starts, and each tool
 * lifecycle transition is emitted once even when TrueForge replays events.
 */
export class SpecialistActivityProjector {
  private readonly narratedMessages = new Set<string>();
  private readonly startedTools = new Set<string>();
  private readonly completedTools = new Set<string>();
  private readonly toolNames = new Map<string, string>();

  sync(messages: SpecialistActivityMessage[]): SpecialistActivityUpdate[] {
    const updates: SpecialistActivityUpdate[] = [];
    const visibleMessages = messages.filter((message) => message.threadId === undefined || message.threadId === "main");
    for (let index = 0; index < visibleMessages.length; index += 1) {
      const message = visibleMessages[index];
      const newCalls = message.toolCalls.filter((call) => call.id && call.name && !this.startedTools.has(call.id));

      // A tool start freezes narration in its own message. Once a later message
      // exists, earlier narration-only messages are also stable and safe to
      // persist without writing token deltas to Convex.
      if (newCalls.length > 0 || index < visibleMessages.length - 1) {
        updates.push(...this.narrate(message));
      }

      for (const call of newCalls) {
        this.startedTools.add(call.id);
        this.toolNames.set(call.id, call.name);
        updates.push({
          type: "activity.tool",
          operationSuffix: `tool:${call.id}:started`,
          payload: { name: call.name, phase: "started", toolCallId: call.id },
        });
      }
    }
    return updates;
  }

  /** Persist final narration-only messages once turn.done proves them stable. */
  flush(messages: SpecialistActivityMessage[]): SpecialistActivityUpdate[] {
    const updates: SpecialistActivityUpdate[] = [];
    for (const message of messages) {
      if (message.threadId !== undefined && message.threadId !== "main") continue;
      updates.push(...this.narrate(message));
    }
    return updates;
  }

  private narrate(message: SpecialistActivityMessage): SpecialistActivityUpdate[] {
    const narration = message.content?.trim();
    if (!narration || this.narratedMessages.has(message.id)) return [];
    const content = narration.length <= 4_000 ? narration : `${narration.slice(0, 3_999)}…`;
    this.narratedMessages.add(message.id);
    return [{
      type: "activity.narration",
      operationSuffix: `narration:${message.id}`,
      payload: { content, messageId: message.id },
    }];
  }

  complete(toolCallId: string): SpecialistActivityUpdate[] {
    const name = this.toolNames.get(toolCallId);
    if (!name || this.completedTools.has(toolCallId)) return [];
    this.completedTools.add(toolCallId);
    return [{
      type: "activity.tool",
      operationSuffix: `tool:${toolCallId}:completed`,
      payload: { name, phase: "completed", toolCallId },
    }];
  }
}
