import test from "node:test";
import assert from "node:assert/strict";

import { createInitialRunState, queueTask } from "./state.js";

test("queueTask keeps higher priority tasks first", () => {
  const state = createInitialRunState("run_test");

  const next = queueTask(
    queueTask(state, {
      id: "low",
      title: "Low",
      description: "Low priority task",
      kind: "operations",
      mode: "building",
      priority: 1,
      blockedByApproval: false,
      status: "pending",
      updatedAt: new Date().toISOString(),
    }),
    {
      id: "high",
      title: "High",
      description: "High priority task",
      kind: "operations",
      mode: "building",
      priority: 10,
      blockedByApproval: false,
      status: "pending",
      updatedAt: new Date().toISOString(),
    },
  );

  assert.equal(next.tasks[0]?.id, "high");
  assert.equal(next.tasks[1]?.id, "low");
});
