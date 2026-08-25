import assert from "node:assert/strict";
import test from "node:test";
import { SerialTaskQueue } from "./serial-task-queue";

test("runs work in request order", async () => {
  const queue = new SerialTaskQueue();
  const events: string[] = [];
  let markFirstStarted: () => void;
  let releaseFirst: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = queue.run(async () => {
    events.push("first:start");
    markFirstStarted!();
    await firstGate;
    events.push("first:finish");
  });
  const second = queue.run(async () => {
    events.push("second:start");
    events.push("second:finish");
  });

  await firstStarted;
  assert.deepEqual(events, ["first:start"]);

  releaseFirst!();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:finish", "second:start", "second:finish"]);
});

test("releases the queue when work fails", async () => {
  const queue = new SerialTaskQueue();
  const failure = new Error("failed run");

  await assert.rejects(queue.run(async () => {
    throw failure;
  }), failure);

  assert.equal(await queue.run(async () => "next run"), "next run");
});
