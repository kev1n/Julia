import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { chatWaiter } from "./autofix-wait.mjs";

const thread = (fields) => ({
  activeRunId: null,
  status: "completed",
  pendingBackgroundTasks: [],
  pendingRuntimeRequest: null,
  latestRunCompletedAt: null,
  latestRunId: null,
  ...fields,
});
const command = { taskId: "checks", kind: "command", awaited: true };

NodeTest.test("a chat whose run ends with nothing left is done", () => {
  const check = chatWaiter();
  NodeAssert.equal(check(thread({ activeRunId: "run:1", status: "running" })), null);
  NodeAssert.equal(check(thread({})), "completed");
});

// The 2026-11-09 sync: the agent's first run ended while checks.sh ran in the
// background; the server dropped the command a moment before it started the run
// that hands the agent the command's result.
NodeTest.test("background work that outlives the run waits for the run it wakes", () => {
  const check = chatWaiter();
  NodeAssert.equal(check(thread({ activeRunId: "run:1", status: "running" })), null);
  NodeAssert.equal(check(thread({ pendingBackgroundTasks: [command] })), null);
  NodeAssert.equal(check(thread({})), null);
  NodeAssert.equal(check(thread({ activeRunId: "run:2", status: "running" })), null);
  NodeAssert.equal(check(thread({})), "completed");
});

// The wake run can start and finish while the stream reconnects: the next snapshot
// shows only a newer latest run.
NodeTest.test("a newer latest run ends the wait for the wake", () => {
  const check = chatWaiter();
  NodeAssert.equal(check(thread({ activeRunId: "run:1", status: "running" })), null);
  const latched = { latestRunId: "run:1", pendingBackgroundTasks: [command] };
  NodeAssert.equal(check(thread(latched)), null);
  NodeAssert.equal(check(thread({ latestRunId: "run:2" })), "completed");
});
