import assert from "node:assert/strict";
import test from "node:test";
import { fallbackConversationTitle } from "./conversation-title";
import { maybeGenerateConversationTitle, mergeStreamingCandidate, orderedAssistantParts, streamingToolCalls, textAfterLastToolCall, toolNamesFromMessages } from "./durable-orchestrator";
import type { AgentRunStore } from "./queue/types";

test("ignores replayed cumulative prefixes until they pass the durable baseline", () => {
  const baseline = "Hello";
  let delta = "";
  for (const candidate of ["H", "He", "Hel", "Hell", "Hello"]) {
    delta = mergeStreamingCandidate(baseline, delta, candidate);
    assert.equal(delta, "");
  }
  delta = mergeStreamingCandidate(baseline, delta, "Hello w");
  assert.equal(delta, " w");
  delta = mergeStreamingCandidate(baseline, delta, "Hello world");
  assert.equal(`${baseline}${delta}`, "Hello world");
});

test("merges replay overlap at the durable-prefix boundary", () => {
  const baseline = "Hello";
  const delta = mergeStreamingCandidate(baseline, "", "lo world");
  assert.equal(`${baseline}${delta}`, "Hello world");
});

test("merges cumulative suffixes and fragmentary candidates without duplication", () => {
  let delta = mergeStreamingCandidate("Hello", "", " world");
  delta = mergeStreamingCandidate("Hello", delta, " world!");
  assert.equal(delta, " world!");

  delta = mergeStreamingCandidate("", "Hello ", "world");
  assert.equal(delta, "Hello world");
});

test("uses resolved TrueForge metadata before wrapper arguments finish streaming", () => {
  const messages = new Map<string, Record<string, unknown>>([["message-1", {
    type: "model.message",
    threadId: "main",
    toolCalls: [{
      id: "call-1",
      function: { name: "call_tool", arguments: "{\"mcp_server\":\"mission-control\"," },
      toolInfo: { type: "mcp", serverName: "mission-control", name: "list_board" },
    }],
  }]]);

  assert.deepEqual(streamingToolCalls(messages), [{
    toolCallId: "call-1",
    toolName: "mission-control.list_board",
    inputText: "{\"mcp_server\":\"mission-control\",",
    inputAvailable: false,
  }]);
});

test("marks complete tool arguments available to the UI stream", () => {
  const messages = new Map<string, Record<string, unknown>>([["message-1", {
    toolCalls: [{
      id: "call-1",
      function: { name: "list_board", arguments: "{\"limit\":10}" },
    }],
  }]]);

  assert.deepEqual(streamingToolCalls(messages), [{
    toolCallId: "call-1",
    toolName: "list_board",
    inputText: "{\"limit\":10}",
    inputAvailable: true,
    input: { limit: 10 },
  }]);
});

test("preserves narration around tools in the durable ordered parts", () => {
  const messages = new Map<string, Record<string, unknown>>([
    ["message-1", {
      threadId: "main",
      content: "I'll check the Mission Control board for you.",
      toolCalls: [{ id: "call-1", function: { name: "list_board", arguments: "{}" } }],
    }],
    ["message-2", { threadId: "main", content: "The board is currently empty." }],
  ]);

  assert.deepEqual(orderedAssistantParts(messages, "", new Map([["call-1", "output-available"]])), [
    { type: "text", text: "I'll check the Mission Control board for you." },
    { type: "tool", toolCallId: "call-1", toolName: "list_board", state: "output-available" },
    { type: "text", text: "The board is currently empty." },
  ]);
});

test("drops transient narration from the legacy durable response after a tool call", () => {
  const messages = new Map<string, Record<string, unknown>>([
    ["message-1", {
      threadId: "main",
      content: "I'll check the Mission Control board for you.",
      toolCalls: [{ id: "call-1" }],
    }],
    ["message-2", { threadId: "main", content: "The board is currently empty." }],
  ]);

  assert.equal(textAfterLastToolCall(messages, ""), "The board is currently empty.");
});

test("returns an empty durable response while the final tool has no follow-up text", () => {
  const messages = new Map<string, Record<string, unknown>>([
    ["message-1", {
      threadId: "main",
      content: "I'll check the board.",
      toolCalls: [{ id: "call-1" }],
    }],
  ]);

  assert.equal(textAfterLastToolCall(messages, "I'll check the board."), "");
});

test("preserves every tool call in provider order, including repeated tools", () => {
  const messages = new Map<string, Record<string, unknown>>([
    ["message-1", {
      toolCalls: [
        { id: "call-1", function: { name: "get_task", arguments: "{}" } },
        { id: "call-2", function: { name: "get_task", arguments: "{}" } },
      ],
    }],
    ["message-2", {
      toolCalls: [{ id: "call-3", function: { name: "list_board", arguments: "{}" } }],
    }],
  ]);

  assert.deepEqual(toolNamesFromMessages(messages), ["get_task", "get_task", "list_board"]);
});

test("retries title generation from the original seed after an empty attempt", async () => {
  const seedMessage = "Research durable queue recovery";
  let title = fallbackConversationTitle(seedMessage);
  const store = {
    getConversationTitleState: async () => ({ title, seedMessage }),
    updateConversationTitle: async (input: { expectedTitle: string; title: string }) => {
      if (title !== input.expectedTitle) return false;
      title = input.title;
      return true;
    },
  } as unknown as AgentRunStore;

  assert.equal(await maybeGenerateConversationTitle(store, {} as never, "conversation-1", async () => null), "empty");
  assert.equal(await maybeGenerateConversationTitle(store, {} as never, "conversation-1", async (_client, prompt) => {
    assert.equal(prompt, seedMessage);
    return "Durable Queue Recovery";
  }), "updated");
  assert.equal(title, "Durable Queue Recovery");
});

test("does not overwrite a title changed while generation is in flight", async () => {
  const seedMessage = "Inspect the mission board";
  let title = fallbackConversationTitle(seedMessage);
  const store = {
    getConversationTitleState: async () => ({ title, seedMessage }),
    updateConversationTitle: async (input: { expectedTitle: string; title: string }) => {
      if (title !== input.expectedTitle) return false;
      title = input.title;
      return true;
    },
  } as unknown as AgentRunStore;

  const result = await maybeGenerateConversationTitle(store, {} as never, "conversation-1", async () => {
    title = "Manually Renamed";
    return "Generated Board Title";
  });
  assert.equal(result, "stale");
  assert.equal(title, "Manually Renamed");
});
