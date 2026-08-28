import assert from "node:assert/strict";
import test from "node:test";
import { visibleStreamText } from "./stream-display";

test("shows narration until a tool part arrives", () => {
  const narration = [{ type: "text", text: "I'll check the board." }];
  assert.equal(visibleStreamText(narration, "I'll check the board."), "I'll check the board.");

  assert.equal(visibleStreamText([
    ...narration,
    { type: "dynamic-tool", toolName: "mission-control.list_board", state: "input-available" },
  ], "I'll check the board."), "");
});

test("shows only answer text produced after the latest tool", () => {
  assert.equal(visibleStreamText([
    { type: "text", text: "I'll check the board." },
    { type: "dynamic-tool", toolName: "mission-control.list_board", state: "output-available" },
    { type: "text", text: "The board is currently empty." },
  ], "I'll check the board.The board is currently empty."), "The board is currently empty.");
});
