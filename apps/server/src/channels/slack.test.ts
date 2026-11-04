import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { escapeSlackText, parseSlackRef, readSlackMessage, routerMessageText } from "./slack.ts";

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
      author: "@USOMEONE",
    });
    assert.isNull(read({ channel: "COTHER", user: "USOMEONE", text: `<@${BOT}> do it` }));
    assert.include(read({ channel: "COTHER", user: "UME", text: `<@${BOT}> do it` }), {
      text: "do it",
      fromUser: true,
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

describe("router messages and replies", () => {
  it("heads a message with where it came from and how to reply", () => {
    const message = read({ channel: "CWATCH", user: "UX" })!;
    assert.strictEqual(
      routerMessageText(message),
      "[slack #CWATCH from @UX ref=slack:CWATCH:1700000000.000100]\nhello",
    );
  });

  it("accepts only refs the adapter made, and escapes what could ping or link", () => {
    assert.deepStrictEqual(Option.getOrNull(parseSlackRef("slack:C1:1700.0001")), {
      channel: "C1",
      threadTs: "1700.0001",
    });
    assert.isTrue(Option.isNone(parseSlackRef("slack:C1:<!channel>")));
    assert.strictEqual(escapeSlackText("<!channel> & <@U1>"), "&lt;!channel&gt; &amp; &lt;@U1&gt;");
  });
});
