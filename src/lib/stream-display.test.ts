import assert from "node:assert/strict";
import test from "node:test";
import { orderedStreamParts } from "./stream-display";

test("preserves narration before and after tools in provider order", () => {
  const parts = [
    { type: "text", text: "I'll check the board." },
    { type: "dynamic-tool", toolName: "mission-control.list_board", state: "output-available" },
    { type: "text", text: "The board is currently empty." },
  ];
  assert.deepEqual(orderedStreamParts(parts, "fallback"), parts);
});

test("uses durable text as a fallback when structured parts are unavailable", () => {
  assert.deepEqual(orderedStreamParts(undefined, "The board is empty."), [
    { type: "text", text: "The board is empty." },
  ]);
  assert.deepEqual(orderedStreamParts([], ""), []);
});
