import assert from "node:assert/strict";
import test from "node:test";
import { buildKickoff } from "./engine";

test("uses TASK_ID only for the assigned task", () => {
  const kickoff = buildKickoff({
    missionTitle: "Mission",
    missionGoal: "Goal",
    taskTitle: "Assignment",
    taskDetail: "Detail",
    taskId: "task-1",
    dependencies: [{
      id: "task-0",
      title: "Previous task",
      role: "researcher",
      column: "settled",
      summary: "Summary",
      documents: [],
    }],
    successors: [{ id: "task-2", title: "Next task", role: "writer" }],
  });

  assert.equal((kickoff.match(/TASK_ID:/g) ?? []).length, 1);
  assert.match(kickoff, /RELATED_ID: task-0/);
  assert.match(kickoff, /RELATED_ID: task-2/);
});
