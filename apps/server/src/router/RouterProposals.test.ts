import { assert, describe, it } from "@effect/vitest";

import { isProposalThread, PROPOSAL_DENIED_TOOLS, slackOriginOf } from "./RouterProposals.ts";

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

  it("marks proposals by tag, and keeps delegation and messaging behind approval", () => {
    assert.isTrue(isProposalThread({ tags: ["proposal"] }));
    assert.isFalse(isProposalThread({ tags: ["router"] }));
    assert.isFalse(isProposalThread({}));
    for (const tool of ["delegate_task", "create_threads", "t3_thread_launch", "t3_thread_send"]) {
      assert.isTrue(PROPOSAL_DENIED_TOOLS.has(tool));
    }
    assert.isFalse(PROPOSAL_DENIED_TOOLS.has("t3_thread_read"));
  });
});
