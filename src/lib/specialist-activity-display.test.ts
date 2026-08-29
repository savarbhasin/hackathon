import assert from "node:assert/strict";
import test from "node:test";
import { groupConsecutiveSpecialistTools } from "./specialist-activity-display";

test("groups consecutive specialist tools without crossing narration or status boundaries", () => {
  const started = { id: "started", kind: "status" };
  const narration = { id: "narration", kind: "narration" };
  const firstTool = { id: "tool-1", kind: "tool" };
  const secondTool = { id: "tool-2", kind: "tool" };
  const completed = { id: "completed", kind: "status" };

  assert.deepEqual(
    groupConsecutiveSpecialistTools([started, narration, firstTool, secondTool, completed]),
    [
      { type: "item", item: started },
      { type: "item", item: narration },
      { type: "tools", items: [firstTool, secondTool] },
      { type: "item", item: completed },
    ],
  );
});

test("keeps separated tool calls in separate groups", () => {
  const firstTool = { id: "tool-1", kind: "tool" };
  const narration = { id: "narration", kind: "narration" };
  const secondTool = { id: "tool-2", kind: "tool" };

  assert.deepEqual(groupConsecutiveSpecialistTools([firstTool, narration, secondTool]), [
    { type: "tools", items: [firstTool] },
    { type: "item", item: narration },
    { type: "tools", items: [secondTool] },
  ]);
});
