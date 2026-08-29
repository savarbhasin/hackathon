import assert from "node:assert/strict";
import test from "node:test";
import { groupStreamParts, orderedStreamParts } from "./stream-display";

test("preserves narration before and after tools in provider order", () => {
  const parts = [
    { type: "text", text: "I'll check the board." },
    { type: "dynamic-tool", toolName: "mission-control.list_board", state: "output-available" },
    { type: "text", text: "The board is currently empty." },
  ];
  assert.deepEqual(orderedStreamParts(parts, "fallback"), parts);
});

test("groups consecutive tools without crossing narration boundaries", () => {
  const textBefore = { type: "text", text: "I'll inspect the tools." };
  const firstTool = { type: "tool", toolName: "list_tools", state: "output-available" };
  const secondTool = { type: "tool", toolName: "get_tool_info", state: "output-available" };
  const textAfter = { type: "text", text: "I found the action." };
  assert.deepEqual(groupStreamParts([textBefore, firstTool, secondTool, textAfter]), [
    { type: "text", part: textBefore },
    { type: "tools", parts: [firstTool, secondTool] },
    { type: "text", part: textAfter },
  ]);
});

test("uses durable text as a fallback when structured parts are unavailable", () => {
  assert.deepEqual(orderedStreamParts(undefined, "The board is empty."), [
    { type: "text", text: "The board is empty." },
  ]);
  assert.deepEqual(orderedStreamParts([], ""), []);
});
