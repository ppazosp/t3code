import { assert, describe, it } from "@effect/vitest";
import { readChannelHeader } from "@t3tools/contracts";

import {
  isStop,
  originOf,
  reportTarget,
  resultText,
  routerMessageText,
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

  it("posts a task where its proposal came from, whoever wrote the message there", () => {
    assert.strictEqual(reportTarget(thread("t", { tags: [ORIGIN] }), ["slack:"]), ORIGIN);
    assert.isNull(reportTarget(thread("t", { tags: [ORIGIN], archived: true }), ["slack:"]));
    assert.isNull(reportTarget(thread("t", { tags: ["router", ORIGIN] }), ["slack:"]));
    assert.isNull(reportTarget(thread("t"), ["slack:"]));
  });

  it("posts a run's answer, or how it ended without one", () => {
    assert.strictEqual(resultText("completed", " Done. "), "Done.");
    assert.isNull(resultText("completed", null));
    assert.strictEqual(resultText("interrupted", null), "Stopped.");
    assert.strictEqual(resultText("failed", "Tests broke"), "This failed.\n\nTests broke");
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
    assert.include(readChannelHeader(text), { channel: "slack", ref: ORIGIN, fromUser: false });
  });
});
