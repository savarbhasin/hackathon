import assert from "node:assert/strict";
import test from "node:test";
import { SpecialistActivityProjector } from "./specialist-activity";

test("interleaves visible narration before a newly started tool", () => {
  const projector = new SpecialistActivityProjector();
  const messages = [{
    id: "message-1",
    threadId: "main",
    content: "I’ll search the documentation first.",
    toolCalls: [{ id: "call-1", name: "exa.search" }],
  }];

  assert.deepEqual(projector.sync(messages), [
    {
      type: "activity.narration",
      operationSuffix: "narration:message-1",
      payload: { content: "I’ll search the documentation first.", messageId: "message-1" },
    },
    {
      type: "activity.tool",
      operationSuffix: "tool:call-1:started",
      payload: { name: "exa.search", phase: "started", toolCallId: "call-1" },
    },
  ]);
  assert.deepEqual(projector.sync(messages), []);
});

test("records later narration and tools without overwriting prior steps", () => {
  const projector = new SpecialistActivityProjector();
  projector.sync([{
    id: "message-1",
    threadId: "main",
    content: "I’ll search first.",
    toolCalls: [{ id: "call-1", name: "exa.search" }],
  }]);

  assert.deepEqual(projector.sync([
    {
      id: "message-1",
      threadId: "main",
      content: "I’ll search first.",
      toolCalls: [{ id: "call-1", name: "exa.search" }],
    },
    {
      id: "message-2",
      threadId: "main",
      content: "I found the source. I’ll save it now.",
      toolCalls: [{ id: "call-2", name: "mission-control.save_document" }],
    },
  ]), [
    {
      type: "activity.narration",
      operationSuffix: "narration:message-2",
      payload: { content: "I found the source. I’ll save it now.", messageId: "message-2" },
    },
    {
      type: "activity.tool",
      operationSuffix: "tool:call-2:started",
      payload: { name: "mission-control.save_document", phase: "started", toolCallId: "call-2" },
    },
  ]);
});

test("completes known tools once and ignores hidden subagent narration", () => {
  const projector = new SpecialistActivityProjector();
  assert.deepEqual(projector.sync([{
    id: "subagent-message",
    threadId: "worker-1",
    content: "Internal subagent narration",
    toolCalls: [{ id: "hidden-call", name: "internal.tool" }],
  }]), []);

  projector.sync([{
    id: "message-1",
    threadId: "main",
    content: "Checking now.",
    toolCalls: [{ id: "call-1", name: "exa.search" }],
  }]);
  assert.deepEqual(projector.complete("call-1"), [{
    type: "activity.tool",
    operationSuffix: "tool:call-1:completed",
    payload: { name: "exa.search", phase: "completed", toolCallId: "call-1" },
  }]);
  assert.deepEqual(projector.complete("call-1"), []);
  assert.deepEqual(projector.complete("unknown-call"), []);
});
