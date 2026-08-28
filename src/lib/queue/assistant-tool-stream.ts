import type { UIMessageChunk } from "ai";
import type { AssistantToolCall } from "./types";

type ToolProgress = {
  name: string;
  inputText: string;
  inputAvailable: boolean;
  terminal: boolean;
  approvalId?: string;
};

/**
 * Converts cumulative TrueForge tool-call snapshots into the incremental AI SDK
 * UIMessageChunk format persisted by Convex Agent. State is scoped to one
 * component stream, so provider replays on a new worker attempt remain safe.
 */
export class AssistantToolStreamProjector {
  private readonly calls = new Map<string, ToolProgress>();

  sync(calls: AssistantToolCall[]): UIMessageChunk[] {
    const chunks: UIMessageChunk[] = [];
    for (const call of calls) {
      let progress = this.calls.get(call.toolCallId);
      if (!progress) {
        progress = {
          name: call.toolName,
          inputText: "",
          inputAvailable: false,
          terminal: false,
        };
        this.calls.set(call.toolCallId, progress);
        chunks.push({
          type: "tool-input-start",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          dynamic: true,
          providerExecuted: true,
        });
      }

      if (progress.terminal) continue;
      if (call.inputText.startsWith(progress.inputText)) {
        const inputTextDelta = call.inputText.slice(progress.inputText.length);
        if (inputTextDelta) {
          chunks.push({ type: "tool-input-delta", toolCallId: call.toolCallId, inputTextDelta });
          progress.inputText = call.inputText;
        }
      }

      if (call.inputAvailable && !progress.inputAvailable) {
        chunks.push({
          type: "tool-input-available",
          toolCallId: call.toolCallId,
          toolName: progress.name,
          input: call.input ?? {},
          dynamic: true,
          providerExecuted: true,
        });
        progress.inputAvailable = true;
      }
    }
    return chunks;
  }

  complete(toolCallId: string): UIMessageChunk[] {
    const progress = this.calls.get(toolCallId);
    if (!progress || progress.terminal) return [];
    const chunks: UIMessageChunk[] = [];
    if (!progress.inputAvailable) {
      chunks.push({
        type: "tool-input-available",
        toolCallId,
        toolName: progress.name,
        input: {},
        dynamic: true,
        providerExecuted: true,
      });
      progress.inputAvailable = true;
    }
    chunks.push({
      type: "tool-output-available",
      toolCallId,
      output: { status: "completed" },
      dynamic: true,
      providerExecuted: true,
    });
    progress.terminal = true;
    return chunks;
  }

  requestApproval(toolCallId: string, approvalId: string): UIMessageChunk[] {
    const progress = this.calls.get(toolCallId);
    if (!progress || progress.terminal || progress.approvalId) return [];
    const chunks: UIMessageChunk[] = [];
    if (!progress.inputAvailable) {
      chunks.push({
        type: "tool-input-available",
        toolCallId,
        toolName: progress.name,
        input: {},
        dynamic: true,
        providerExecuted: true,
      });
      progress.inputAvailable = true;
    }
    chunks.push({ type: "tool-approval-request", toolCallId, approvalId });
    progress.approvalId = approvalId;
    return chunks;
  }
}
