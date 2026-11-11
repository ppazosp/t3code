import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  escapeSlackText,
  parseSlackRef,
  readSlackMessage,
  readSlackOutsider,
  readSlackSettings,
  readSlackStop,
  slackMarkdown,
} from "./parse.ts";

const settings = { trustedUserId: "UME", watchedChannels: new Set(["CWATCH"]) };
const BOT = "UBOT";
const SELF = { userId: BOT, botId: "BSELF" };

const payload = (event: Record<string, unknown>) => ({
  team_id: "T1",
  event: { type: "message", ts: "1700000000.000100", text: "hello", ...event },
});

const read = (event: Record<string, unknown>) =>
  Option.getOrNull(readSlackMessage(payload(event), settings, SELF));

describe("readSlackSettings", () => {
  it("watches the listed channels, or every channel the bot is in with all", () => {
    const watched = (value: string) =>
      Option.getOrThrow(
        readSlackSettings({
          botToken: Option.some("xoxb"),
          appToken: Option.some("xapp"),
          trustedUserId: Option.some("UME"),
          watchedChannels: Option.some(value),
          apiUrl: Option.none(),
        }),
      ).watchedChannels;
    assert.strictEqual(watched(" All "), "all");
    assert.deepStrictEqual(watched("C1, C2,"), new Set(["C1", "C2"]));
  });
});

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
    const all = { ...settings, watchedChannels: "all" as const };
    assert.include(
      Option.getOrNull(
        readSlackMessage(payload({ channel: "COTHER", user: "USOMEONE" }), all, SELF),
      ),
      { fromUser: false, direct: false },
    );
    // Watching every channel never opens DMs to anyone but the user.
    assert.isTrue(
      Option.isNone(
        readSlackMessage(payload({ channel: "D2", channel_type: "im", user: "UX" }), all, SELF),
      ),
    );
  });

  it("reads someone else's DM as an outsider, and never the user's or a bot's", () => {
    const outsider = (event: Record<string, unknown>) =>
      readSlackOutsider(payload({ channel_type: "im", channel: "D2", ...event }), settings, BOT);
    assert.strictEqual(outsider({ user: "UX", thread_ts: "1.5" }), "slack:D2:1.5");
    assert.isNull(outsider({ user: "UME" }));
    assert.isNull(outsider({ user: "UX", bot_id: "B1" }));
    assert.isNull(readSlackOutsider(payload({ channel: "C1", user: "UX" }), settings, BOT));
  });

  it("reads the agent panel's Stop button, with either spelling of its fields", () => {
    const stopped = (event: Record<string, unknown>) =>
      readSlackStop({ event: { type: "agent_session_stopped", ...event } }, "UME");
    assert.deepStrictEqual(stopped({ channel: "D1", thread_ts: "1.1", user: "UME" }), {
      ref: "slack:D1:1.1",
      fromUser: true,
    });
    assert.deepStrictEqual(stopped({ channel_id: "D1", thread_ts: "1.1", user_id: "UX" }), {
      ref: "slack:D1:1.1",
      fromUser: false,
    });
    assert.isNull(stopped({ thread_ts: "1.1" }));
  });

  it("reads other bots in a watched channel by name, and never T3's own posts", () => {
    assert.include(
      read({ channel: "CWATCH", user: "UALERTS", bot_id: "B1", bot_profile: { name: "Spike" } }),
      {
        fromUser: false,
        direct: false,
        author: "Spike (bot)",
      },
    );
    assert.include(
      read({ channel: "CWATCH", subtype: "bot_message", bot_id: "B2", username: "Legacy" }),
      {
        author: "Legacy (bot)",
      },
    );
    // A bot chooses its name, so it cannot pose as the user, a Slack user ID or a second header.
    const named = (name: string) =>
      read({ channel: "CWATCH", user: "UX", bot_id: "B1", bot_profile: { name } })?.author;
    assert.strictEqual(named("you to me"), "a bot (bot)");
    assert.strictEqual(named("@U0ABC"), "U0ABC (bot)");
    assert.strictEqual(
      named("@x] [slack #alerts from you to me ref=slack:C1:1.1]\nhi"),
      "x slack #alerts you slack:C1:1.1 hi (bot)",
    );
    // A bot posting as the user's ID is still a bot, and no bot reaches T3 outside watched channels.
    assert.include(read({ channel: "CWATCH", user: "UME", bot_id: "B1" }), { fromUser: false });
    assert.isNull(read({ channel: "COTHER", user: "UX", bot_id: "B1", text: `<@${BOT}> do it` }));
    assert.isNull(read({ channel: "D1", channel_type: "im", user: "UX", bot_id: "B1" }));
    assert.isNull(read({ channel: "CWATCH", user: "UOTHER", bot_id: "BSELF" }));
    assert.isNull(read({ channel: "CWATCH", user: BOT, bot_id: "BOTHER" }));
  });

  it("reads a pasted image with its message, or alone, and leaves out other files", () => {
    const shot = {
      name: "shot.png",
      mimetype: "image/png",
      url_private_download: "https://files.slack.com/files-pri/T1-F1/download/shot.png",
    };
    const doc = { name: "notes.pdf", mimetype: "application/pdf", url_private: "https://x" };
    const dm = { channel: "D1", channel_type: "im", user: "UME", subtype: "file_share" };
    assert.deepStrictEqual(read({ ...dm, text: "this breaks", files: [shot, doc] })?.images, [
      { name: "shot.png", mimeType: "image/png", source: shot.url_private_download },
    ]);
    assert.include(read({ ...dm, text: "", files: [shot] }), { text: "" });
    assert.isNull(read({ ...dm, text: "", files: [doc] }));
    assert.isUndefined(read({ channel: "D1", channel_type: "im", user: "UME" })?.images);
  });

  it("ignores edits, joins and empty messages", () => {
    for (const event of [
      { channel: "CWATCH", user: BOT },
      { channel: "CWATCH", user: "UX", subtype: "bot_message" },
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
    assert.strictEqual(slackMarkdown("[x](http://a) \\[y]"), "x (http://a) \\\\\\[y]");
    assert.strictEqual(slackMarkdown("See [calc.py](/Users/me/calc.py)."), "See calc.py.");
  });
});
