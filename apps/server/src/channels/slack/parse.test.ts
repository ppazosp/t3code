import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  APPROVE_ACTION,
  CHANGE_ACTION,
  CHANGE_FORM,
  escapeSlackText,
  parseSlackRef,
  readSlackInteraction,
  readSlackMessage,
  slackMarkdown,
} from "./parse.ts";

const settings = { trustedUserId: "UME", watchedChannels: new Set(["CWATCH"]) };
const BOT = "UBOT";

const payload = (event: Record<string, unknown>) => ({
  team_id: "T1",
  event: { type: "message", ts: "1700000000.000100", text: "hello", ...event },
});

const read = (event: Record<string, unknown>) =>
  Option.getOrNull(readSlackMessage(payload(event), settings, BOT));

describe("readSlackMessage", () => {
  it("reads the user's DMs as requests, and ignores anyone else's", () => {
    assert.deepStrictEqual(read({ channel: "D1", channel_type: "im", user: "UME" }), {
      id: "slack:D1:1700000000.000100",
      ref: "slack:D1:1700000000.000100",
      fromUser: true,
      direct: true,
      where: "dm",
      author: "you",
      text: "hello",
    });
    assert.isNull(read({ channel: "D2", channel_type: "im", user: "USOMEONE" }));
  });

  it("reads every person in a watched channel, and only the user's mentions elsewhere", () => {
    assert.include(read({ channel: "CWATCH", user: "USOMEONE", thread_ts: "1699.1" }), {
      ref: "slack:CWATCH:1699.1",
      fromUser: false,
      direct: false,
      author: "@USOMEONE",
    });
    assert.isNull(read({ channel: "COTHER", user: "USOMEONE", text: `<@${BOT}> do it` }));
    assert.include(read({ channel: "COTHER", user: "UME", text: `<@${BOT}> do it` }), {
      text: "do it",
      fromUser: true,
      direct: true,
    });
  });

  it("ignores bots, edits, joins and empty messages", () => {
    for (const event of [
      { channel: "CWATCH", user: "UX", bot_id: "B1" },
      { channel: "CWATCH", user: BOT },
      { channel: "CWATCH", user: "UX", subtype: "message_changed" },
      { channel: "CWATCH", user: "UX", subtype: "channel_join" },
      { channel: "CWATCH", user: "UX", text: "   " },
      { channel: "CWATCH" },
    ]) {
      assert.isNull(read(event));
    }
  });
});

describe("refs and replies", () => {
  it("accepts only refs the adapter made, and escapes what could ping or link", () => {
    assert.deepStrictEqual(Option.getOrNull(parseSlackRef("slack:C1:1700.0001")), {
      channel: "C1",
      threadTs: "1700.0001",
    });
    assert.isTrue(Option.isNone(parseSlackRef("slack:C1:<!channel>")));
    assert.strictEqual(escapeSlackText("<!channel> & <@U1>"), "&lt;!channel&gt; &amp; &lt;@U1&gt;");
    // Markdown links stay text, and a backslash cannot undo that.
    assert.strictEqual(slackMarkdown("[x](http://a) \\[y]"), "\\[x](http://a) \\\\\\[y]");
  });
});

describe("readSlackInteraction", () => {
  const click = (action: string, user = "UME") => ({
    type: "block_actions",
    user: { id: user },
    trigger_id: "trigger-1",
    container: { channel_id: "D1", message_ts: "1700000000.000300" },
    actions: [{ action_id: action, value: "plan:t:p" }],
  });

  it("reads Approve as an answer, and Change as a form to open", () => {
    assert.deepStrictEqual(readSlackInteraction(click(APPROVE_ACTION), "UME"), {
      type: "answer",
      answer: {
        askId: "plan:t:p",
        message: "slack:D1:1700000000.000300",
        fromUser: true,
        decision: "approve",
        text: "",
      },
    });
    assert.include(readSlackInteraction(click(APPROVE_ACTION, "UX"), "UME")!, { type: "answer" });
    const form = readSlackInteraction(click(CHANGE_ACTION), "UME");
    assert.strictEqual(form?.type, "openForm");
    assert.isNull(readSlackInteraction({ ...click("other"), actions: [] }, "UME"));
  });

  it("reads the sent Change form as an answer with what to change", () => {
    const form = readSlackInteraction(click(CHANGE_ACTION), "UME");
    if (form?.type !== "openForm") throw new Error("expected a form");
    const sent = readSlackInteraction(
      {
        type: "view_submission",
        user: { id: "UME" },
        view: {
          callback_id: CHANGE_FORM,
          private_metadata: form.context,
          state: { values: { change: { text: { value: " add CSV " } } } },
        },
      },
      "UME",
    );
    assert.deepStrictEqual(sent, {
      type: "answer",
      answer: {
        askId: "plan:t:p",
        message: "slack:D1:1700000000.000300",
        fromUser: true,
        decision: "change",
        text: "add CSV",
      },
    });
  });
});
