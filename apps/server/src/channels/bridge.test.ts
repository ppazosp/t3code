import { assert, describe, it } from "@effect/vitest";

import { originOf, reportTarget, taskForMessage, type BridgeThread } from "./bridge.ts";

const ORIGIN = "slack:C1:1700000000.000100";
const thread = (id: string, fields: Partial<BridgeThread> = {}): BridgeThread => ({
  id,
  projectId: "project:1",
  title: id,
  tags: [],
  interactionMode: "default",
  archived: false,
  ...fields,
});
const reply = { id: "m", ref: ORIGIN, fromUser: true, where: "#C1", author: "you", text: "hi" };

describe("bridge", () => {
  it("finds a task's origin among its tags", () => {
    assert.strictEqual(originOf(thread("a", { tags: ["proposal", ORIGIN] }), ["slack:"]), ORIGIN);
    assert.isNull(originOf(thread("a", { tags: ["proposal"] }), ["slack:"]));
  });

  it("answers a task only when exactly one live task came from that conversation", () => {
    const task = thread("task", { tags: [ORIGIN] });
    assert.strictEqual(taskForMessage(reply, [task], ["slack:"]), task);
    assert.isNull(taskForMessage({ ...reply, fromUser: false }, [task], ["slack:"]));
    assert.isNull(taskForMessage(reply, [task, thread("other", { tags: [ORIGIN] })], ["slack:"]));
    assert.isNull(
      taskForMessage(reply, [thread("old", { tags: [ORIGIN], archived: true })], ["slack:"]),
    );
    assert.isNull(
      taskForMessage(reply, [thread("router", { tags: ["router", ORIGIN] })], ["slack:"]),
    );
  });

  it("reports a task's runs only once approved, and only where the user asked for it", () => {
    assert.strictEqual(
      reportTarget(thread("t", { tags: [ORIGIN, "from-you"] }), ["slack:"]),
      ORIGIN,
    );
    // A task from someone else's message in a watched channel never posts in their thread.
    assert.isNull(reportTarget(thread("t", { tags: [ORIGIN] }), ["slack:"]));
    assert.isNull(reportTarget(thread("t", { tags: ["proposal", ORIGIN] }), ["slack:"]));
    assert.isNull(
      reportTarget(thread("t", { tags: [ORIGIN], interactionMode: "plan" }), ["slack:"]),
    );
    assert.isNull(reportTarget(thread("t"), ["slack:"]));
  });
});
