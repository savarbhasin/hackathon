import assert from "node:assert/strict";
import test from "node:test";
import { mergeStreamingCandidate } from "./durable-orchestrator";

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
