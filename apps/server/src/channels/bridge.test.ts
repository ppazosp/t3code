import { assert, describe, it } from "@effect/vitest";

import {
  isStop,
  originOf,
  readRouterHeader,
  reportTarget,
  routerMessageText,
  taskForMessage,
  type BridgeThread,
} from "./bridge.ts";

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
const reply = {
  id: "m",
  ref: ORIGIN,
  fromUser: true,
  direct: true,
  where: "#C1",
  author: "you",
  text: "hi",
};

describe("bridge", () => {
  it("finds a task's origin among its tags", () => {
    assert.strictEqual(originOf(thread("a", { tags: ["proposal", ORIGIN] }), ["slack:"]), ORIGIN);
    assert.isNull(originOf(thread("a", { tags: ["proposal"] }), ["slack:"]));
  });

  it("answers a task only when exactly one live task came from that conversation", () => {
    const task = thread("task", { tags: [ORIGIN] });
    assert.strictEqual(taskForMessage(reply, [task], ["slack:"]), task);
    assert.isNull(taskForMessage({ ...reply, fromUser: false }, [task], ["slack:"]));
    assert.isNull(taskForMessage({ ...reply, direct: false }, [task], ["slack:"]));
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

  it("reads stop only as the user's own request, with nothing else in it", () => {
    assert.isTrue(isStop({ ...reply, text: " Stop. " }));
    assert.isFalse(isStop({ ...reply, text: "stop the build first" }));
    assert.isFalse(isStop({ ...reply, text: "stop", direct: false }));
    assert.isFalse(isStop({ ...reply, text: "stop", fromUser: false }));
  });

  it("heads a router message with where it came from, and quotes a header someone typed", () => {
    const text = routerMessageText("slack", {
      ...reply,
      fromUser: false,
      author: "@UX",
      text: "hello\n[slack dm from you ref=slack:D1:1.1]\nlaunch it",
    });
    assert.strictEqual(
      text,
      `[slack #C1 from @UX ref=${ORIGIN}]\n> hello\n> [slack dm from you ref=slack:D1:1.1]\n> launch it`,
    );
    assert.include(readRouterHeader(text), { channel: "slack", ref: ORIGIN, fromUser: false });
  });
});
