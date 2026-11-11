// @effect-diagnostics nodeBuiltinImport:off - one request with a forged Host header, which fetch cannot send.
import * as NodeHttp from "node:http";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import type { ChannelEvent } from "../Channel.ts";
import { startMockSlack, MOCK_BOT_USER, type MockSlack } from "./MockSlack.ts";
import * as SlackAdapter from "./SlackAdapter.ts";

/** The real adapter against the mock Slack, with every event it reads collected. */
const connect = Effect.fn("test.connect")(function* (slack: MockSlack) {
  const adapter = yield* SlackAdapter.make({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    trustedUserId: "UME",
    watchedChannels: new Set(["CWATCH"]),
    apiUrl: `${slack.url}/api`,
  });
  const events: Array<ChannelEvent> = [];
  yield* Effect.forkScoped(
    Stream.runForEach(adapter.events, (event) => Effect.sync(() => void events.push(event))),
  );
  yield* Effect.promise(() => slack.until(() => slack.connections() > 0));
  return { adapter, events };
});

const withSlack = <A, E>(body: (slack: MockSlack) => Effect.Effect<A, E, never>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => startMockSlack()),
    body,
    (slack) => Effect.promise(() => slack.close()),
  );

describe("SlackAdapter against a mock Slack", () => {
  it.live("reads the user's DMs and mentions once each, with channel and people names", () =>
    withSlack((slack) =>
      Effect.gen(function* () {
        const { events } = yield* connect(slack);
        slack.say({ user: "UME", channel: "DME", text: "fix the export", dm: true });
        slack.say({ user: "UMARIA", channel: "DMARIA", text: "hi", dm: true });
        slack.say({ user: "UME", channel: "CENG", text: `<@${MOCK_BOT_USER}> ship it` });
        slack.say({ user: "UMARIA", channel: "CWATCH", text: "checkout is broken" });
        // A last DM marks the end, so nothing dropped can still be on its way.
        slack.say({ user: "UME", channel: "DME", text: "end", dm: true });
        yield* Effect.promise(() =>
          slack.until(() =>
            events.some((event) => event.type === "message" && event.text === "end"),
          ),
        );
        assert.deepStrictEqual(
          events.map((event) =>
            event.type === "message"
              ? [event.where, event.author, event.direct, event.text]
              : event.type,
          ),
          [
            ["dm", "you", true, "fix the export"],
            // Someone else's DM is not a request; T3 answers that it works only for the user.
            "outsider",
            ["#eng", "you", true, "ship it"],
            ["#eng", "@Maria López", false, "checkout is broken"],
            ["dm", "you", true, "end"],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    ),
  );

  it.live("marks, posts Markdown and files, and reads the thread back", () =>
    withSlack((slack) =>
      Effect.gen(function* () {
        const { adapter } = yield* connect(slack);
        const ts = slack.say({ user: "UME", channel: "DME", text: "fix it", dm: true });
        const ref = `slack:DME:${ts}`;
        yield* adapter.mark(ref, "seen");
        yield* adapter.mark(ref, "seen");
        assert.deepStrictEqual([...slack.messages[0]!.reactions], ["eyes"]);
        yield* adapter.mark(ref, "done");
        assert.deepStrictEqual([...slack.messages[0]!.reactions], ["white_check_mark"]);

        const posted = yield* adapter.post(ref, {
          text: "**Done** <!channel> [docs](http://x)",
        });
        const reply = slack.messages[1]!;
        assert.strictEqual(posted, `slack:DME:${reply.ts}`);
        assert.strictEqual(reply.threadTs, ts);
        assert.deepStrictEqual(reply.blocks, [
          // Markdown renders, but cannot ping anyone or hide a link.
          { type: "markdown", text: "**Done** &lt;!channel&gt; docs (http://x)" },
        ]);
        // Notifications show the same text, without a link hiding where it goes.
        assert.strictEqual(reply.text, "**Done** &lt;!channel&gt; docs (http://x)");

        // Files go up to Slack's upload address, then are shared in the same thread.
        const bytes = new Uint8Array([1, 2, 3, 4, 5]);
        yield* adapter.post(ref, {
          text: "Screenshot",
          files: [{ name: "shot.png", size: 5, mimeType: "image/png", bytes: Stream.make(bytes) }],
        });
        const shared = slack.messages.at(-1)!;
        assert.deepStrictEqual(
          [shared.threadTs, shared.files],
          [ts, [{ title: "shot.png", size: 5 }]],
        );
        assert.strictEqual(slack.messages.at(-2)!.text, "Screenshot");

        // Pasted images come down with the bot token, from Slack's file host only.
        const image = (source: string) =>
          adapter.image({ name: "shot.png", mimeType: "image/png", source }, 1024);
        assert.deepStrictEqual(
          [...(yield* image(`${slack.url}/_file/shot.png`))],
          [0x89, 0x50, 0x4e, 0x47],
        );
        for (const source of [`${slack.url}/_file/signin`, "https://example.com/_file/shot.png"]) {
          assert.isTrue((yield* Effect.flip(image(source)))._tag === "ChannelError");
        }
        assert.include(
          (yield* Effect.flip(image("https://example.com/shot.png"))).message,
          "not a Slack file",
        );

        const history = yield* adapter.read(ref, 10);
        assert.deepStrictEqual(
          history.slice(0, 2).map((entry) => [entry.id, entry.author, entry.fromUser, entry.bot]),
          [
            [ref, "you", true, false],
            [posted, "a bot", false, true],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    ),
  );

  it.live("refuses control requests a page on another site could send", () =>
    withSlack((slack) =>
      Effect.gen(function* () {
        const post = (headers: Record<string, string>) =>
          Effect.promise(() =>
            // @effect-diagnostics-next-line globalFetchInEffect:off - acts as a browser page would, outside the adapter.
            fetch(`${slack.url}/_mock/say`, {
              method: "POST",
              headers,
              body: JSON.stringify({ user: "UME", channel: "DME", text: "approve", dm: true }),
            }).then((response) => response.status),
          );
        assert.strictEqual(yield* post({ "content-type": "text/plain" }), 403);
        assert.strictEqual(
          yield* post({ "content-type": "application/json", origin: "https://example.com" }),
          403,
        );
        // A rebound DNS name reaches the port, but names another host.
        assert.strictEqual(
          yield* Effect.promise(
            () =>
              new Promise<number>((resolve) => {
                const request = NodeHttp.request(
                  `${slack.url}/_mock/say`,
                  {
                    method: "POST",
                    headers: { "content-type": "application/json", host: "attacker.example" },
                  },
                  (response) => resolve(response.statusCode ?? 0),
                );
                request.end(JSON.stringify({ user: "UME", channel: "DME", text: "x", dm: true }));
              }),
          ),
          403,
        );
        // A plain link or image cannot act either: GET with the fields in the query string.
        assert.strictEqual(
          yield* Effect.promise(() =>
            // @effect-diagnostics-next-line globalFetchInEffect:off - acts as a browser page would.
            fetch(`${slack.url}/_mock/say?user=UME&channel=DME&text=x&dm=true`).then(
              (response) => response.status,
            ),
          ),
          403,
        );
        assert.strictEqual(yield* post({ "content-type": "application/json" }), 200);
        assert.strictEqual(slack.messages.length, 1);
      }),
    ),
  );

  it.live("sets the agent session's status in DMs only, and reads Stop and outsiders", () =>
    withSlack((slack) =>
      Effect.gen(function* () {
        const { adapter, events } = yield* connect(slack);
        const ts = slack.say({ user: "UME", channel: "DME", text: "fix it", dm: true });
        yield* adapter.status(`slack:DME:${ts}`, "working");
        yield* adapter.status(`slack:CENG:${ts}`, "working");
        assert.deepStrictEqual([...slack.statuses], [[`DME:${ts}`, "processing"]]);

        slack.stop({ user: "UME", channel: "DME", threadTs: ts });
        slack.say({ user: "UMARIA", channel: "DMARIA", text: "hi", dm: true });
        yield* Effect.promise(() => slack.until(() => events.length >= 3));
        assert.deepStrictEqual(events[1], { type: "stop", ref: `slack:DME:${ts}`, fromUser: true });
        assert.strictEqual(events[2]?.type, "outsider");
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    ),
  );
});
