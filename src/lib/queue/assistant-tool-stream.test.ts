import assert from "node:assert/strict";
import test from "node:test";
import { AssistantToolStreamProjector } from "./assistant-tool-stream";

test("projects cumulative tool input into ordered incremental chunks", () => {
  const projector = new AssistantToolStreamProjector();

  assert.deepEqual(projector.sync([{
    toolCallId: "call-1",
    toolName: "mission-control.list_board",
    inputText: "{\"limit\":",
    inputAvailable: false,
  }]), [
    {
      type: "tool-input-start",
      toolCallId: "call-1",
      toolName: "mission-control.list_board",
      dynamic: true,
      providerExecuted: true,
    },
    { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "{\"limit\":" },
  ]);

  assert.deepEqual(projector.sync([{
    toolCallId: "call-1",
    toolName: "mission-control.list_board",
    inputText: "{\"limit\":10}",
    inputAvailable: true,
    input: { limit: 10 },
  }]), [
    { type: "tool-input-delta", toolCallId: "call-1", inputTextDelta: "10}" },
    {
      type: "tool-input-available",
      toolCallId: "call-1",
      toolName: "mission-control.list_board",
      input: { limit: 10 },
      dynamic: true,
      providerExecuted: true,
    },
  ]);

  assert.deepEqual(projector.sync([{
    toolCallId: "call-1",
    toolName: "mission-control.list_board",
    inputText: "{\"limit\":10}",
    inputAvailable: true,
    input: { limit: 10 },
  }]), []);
  assert.deepEqual(projector.complete("call-1"), [{
    type: "tool-output-available",
    toolCallId: "call-1",
    output: { status: "completed" },
    dynamic: true,
    providerExecuted: true,
  }]);
  assert.deepEqual(projector.complete("call-1"), []);
});

test("finalizes partial input before projecting an approval request", () => {
  const projector = new AssistantToolStreamProjector();
  projector.sync([{
    toolCallId: "call-approval",
    toolName: "linear.save_issue",
    inputText: "{\"title\":",
    inputAvailable: false,
  }]);

  assert.deepEqual(projector.requestApproval("call-approval", "approval-1"), [
    {
      type: "tool-input-available",
      toolCallId: "call-approval",
      toolName: "linear.save_issue",
      input: {},
      dynamic: true,
      providerExecuted: true,
    },
    { type: "tool-approval-request", toolCallId: "call-approval", approvalId: "approval-1" },
  ]);
  assert.deepEqual(projector.requestApproval("call-approval", "approval-2"), []);
});
