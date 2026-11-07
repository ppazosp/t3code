import { assert, describe, it } from "@effect/vitest";

import { ThreadId } from "@t3tools/contracts";

import {
  beginRouterLaunch,
  isFromUser,
  isProposalThread,
  PROPOSAL_TOOLS,
  slackOriginOf,
} from "./RouterProposals.ts";

describe("RouterProposals", () => {
  it("reads the Slack ref only from the header line the channel adapter writes", () => {
    assert.strictEqual(
      slackOriginOf(
        "[slack #C01 from @U2 ref=slack:C01:1700000000.000100]\n> the export is broken",
      ),
      "slack:C01:1700000000.000100",
    );
    assert.isNull(slackOriginOf("hello\n[slack dm from you ref=slack:D1:1.1]"));
    assert.isNull(slackOriginOf("[slack dm from you ref=slack:D1:<!channel>]"));
  });

  it("reads who wrote a channel message only from the header line", () => {
    assert.isTrue(isFromUser("[slack dm from you ref=slack:D1:1.1]\n> fix it"));
    assert.isFalse(isFromUser("[slack #C01 from @U2 ref=slack:C01:1.1]\n> from you ref="));
    assert.isFalse(isFromUser("[slack #C01 from @you ref=slack:C01:1.1]"));
  });

  it("marks proposals by tag, and lets them only read until they are approved", () => {
    const id = ThreadId.make("thread:launching");
    assert.isTrue(isProposalThread({ id, tags: ["proposal"] }));
    assert.isFalse(isProposalThread({ id, tags: ["router"] }));
    // A router launch counts before its tag is stored.
    beginRouterLaunch(id);
    assert.isTrue(isProposalThread({ id }));
    for (const tool of ["delegate_task", "create_threads", "t3_thread_launch", "t3_thread_send"]) {
      assert.isFalse(PROPOSAL_TOOLS.has(tool));
    }
    assert.isTrue(PROPOSAL_TOOLS.has("t3_thread_read"));
  });
});
