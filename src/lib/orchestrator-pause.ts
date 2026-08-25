import { randomUUID } from "node:crypto";

export interface PauseAction {
  selector: string;
  type: string;
  name?: string;
  question?: string;
  options?: string[];
  argsPreview?: string;
}

export interface PersistedPauseAction extends PauseAction {
  threadId?: string | null;
  toolCallId: string;
}

export interface ResumeSelection {
  selector: string;
  decision?: "allow" | "deny";
  content?: string;
}

export interface ProviderResumeInput {
  type: "user.tool_approval" | "user.tool_response";
  threadId?: string | null;
  toolCallId: string;
  approval?: { status: "allow" } | { status: "deny"; reason: string };
  content?: string;
}

export class ResumeStateError extends Error {
  constructor(
    public readonly code:
      | "invalid_resume_payload"
      | "no_pending_pause"
      | "malformed_pause_state"
      | "duplicate_pause_selector"
      | "stale_pause_action"
      | "approval_decision_required"
      | "response_content_required"
      | "unsupported_pause_action",
    message: string
  ) {
    super(message);
    this.name = "ResumeStateError";
  }
}

export function createPauseSelector(): string {
  return `pause_${randomUUID()}`;
}

export function legacyPauseSelector(messageId: string, index: number): string {
  return `legacy_${messageId}_${index}`;
}

export function parseResumeSelections(value: unknown): ResumeSelection[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new ResumeStateError("invalid_resume_payload", "Send one or more pause selections.");
  }

  return value.map((item) => {
    if (!isRecord(item)) {
      throw new ResumeStateError("invalid_resume_payload", "Each pause selection must be an object.");
    }
    for (const key of Object.keys(item)) {
      if (key !== "selector" && key !== "decision" && key !== "content") {
        throw new ResumeStateError(
          "invalid_resume_payload",
          "Pause selections may only include selector, decision, and content."
        );
      }
    }

    const selector = typeof item.selector === "string" ? item.selector.trim() : "";
    if (!selector) {
      throw new ResumeStateError("invalid_resume_payload", "Each pause selection needs a selector.");
    }
    if (item.decision !== undefined && item.decision !== "allow" && item.decision !== "deny") {
      throw new ResumeStateError("invalid_resume_payload", "Approval decisions must be allow or deny.");
    }
    if (item.content !== undefined && typeof item.content !== "string") {
      throw new ResumeStateError("invalid_resume_payload", "Response content must be text.");
    }

    return {
      selector,
      decision: item.decision,
      content: item.content,
    };
  });
}

export function parsePersistedPauseActions(raw: string, messageId: string): PersistedPauseAction[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ResumeStateError("malformed_pause_state", "The saved pause state is unreadable. It was left unchanged.");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new ResumeStateError("malformed_pause_state", "The saved pause state is incomplete. It was left unchanged.");
  }

  const selectors = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ResumeStateError("malformed_pause_state", "The saved pause state is incomplete. It was left unchanged.");
    }
    const type = typeof item.type === "string" ? item.type : "";
    const toolCallId = typeof item.toolCallId === "string" ? item.toolCallId : "";
    const selector = typeof item.selector === "string" && item.selector.trim()
      ? item.selector.trim()
      : legacyPauseSelector(messageId, index);
    if (!type || !toolCallId || selectors.has(selector)) {
      throw new ResumeStateError("malformed_pause_state", "The saved pause state is incomplete. It was left unchanged.");
    }
    selectors.add(selector);

    return {
      selector,
      type,
      toolCallId,
      threadId: typeof item.threadId === "string" || item.threadId === null ? item.threadId : undefined,
      name: typeof item.name === "string" ? item.name : undefined,
      question: typeof item.question === "string" ? item.question : undefined,
      options: Array.isArray(item.options) && item.options.every((option) => typeof option === "string")
        ? item.options
        : undefined,
      argsPreview: typeof item.argsPreview === "string" ? item.argsPreview : undefined,
    };
  });
}

export function toClientPauseAction(action: PersistedPauseAction): PauseAction {
  const { threadId: _threadId, toolCallId: _toolCallId, ...clientAction } = action;
  return clientAction;
}

export function buildProviderResumeInput(
  actions: PersistedPauseAction[],
  selections: ResumeSelection[]
): ProviderResumeInput[] {
  const seen = new Set<string>();
  const actionBySelector = new Map(actions.map((action) => [action.selector, action]));

  return selections.map((selection) => {
    if (seen.has(selection.selector)) {
      throw new ResumeStateError("duplicate_pause_selector", "That paused action was submitted more than once.");
    }
    seen.add(selection.selector);

    const action = actionBySelector.get(selection.selector);
    if (!action) {
      throw new ResumeStateError(
        "stale_pause_action",
        "That paused action is no longer current. Refresh the conversation and try again."
      );
    }

    if (action.type === "tool.approval_required") {
      if (selection.decision !== "allow" && selection.decision !== "deny") {
        throw new ResumeStateError(
          "approval_decision_required",
          "Choose Approve or Deny for this action."
        );
      }
      return {
        type: "user.tool_approval",
        threadId: action.threadId,
        toolCallId: action.toolCallId,
        approval: selection.decision === "allow"
          ? { status: "allow" }
          : { status: "deny", reason: "denied by user" },
      };
    }

    if (action.type === "tool.response_required") {
      const content = selection.content?.trim() ?? "";
      if (!content) {
        throw new ResumeStateError("response_content_required", "Enter a response before continuing.");
      }
      return {
        type: "user.tool_response",
        threadId: action.threadId,
        toolCallId: action.toolCallId,
        content,
      };
    }

    throw new ResumeStateError(
      "unsupported_pause_action",
      `This pause type cannot be resumed in chat: ${action.type}.`
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
