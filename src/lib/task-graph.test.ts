import assert from "node:assert/strict";
import test from "node:test";
import { dependencyIds, findDependencyCycle } from "./task-graph";

test("dependencyIds accepts only non-empty string IDs", () => {
  assert.deepEqual(dependencyIds('["a", "", 3, "b"]'), ["a", "b"]);
  assert.deepEqual(dependencyIds("not json"), []);
});

test("findDependencyCycle accepts a valid graph", () => {
  assert.equal(
    findDependencyCycle([
      { id: "research", dependsOn: [] },
      { id: "write", dependsOn: ["research"] },
      { id: "file", dependsOn: ["write"] },
    ]),
    null
  );
});

test("findDependencyCycle returns the closed cycle path", () => {
  assert.deepEqual(
    findDependencyCycle([
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["c"] },
      { id: "c", dependsOn: ["a"] },
    ]),
    ["a", "b", "c", "a"]
  );
});
