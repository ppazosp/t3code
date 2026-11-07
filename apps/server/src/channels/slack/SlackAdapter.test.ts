import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";

import type { ChannelEvent } from "../Channel.ts";
import { startMockSlack, MOCK_BOT_USER, type MockSlack } from "./MockSlack.ts";
import { APPROVE_ACTION, CHANGE_ACTION } from "./parse.ts";
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
            event.type === "message" ? [event.where, event.author, event.direct, event.text] : null,
          ),
          [
            ["dm", "you", true, "fix the export"],
            ["#eng", "you", true, "ship it"],
            ["#eng", "@Maria López", false, "checkout is broken"],
            ["dm", "you", true, "end"],
          ],
        );
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    ),
  );

  it.live("marks, posts, reads and shows progress in the thread", () =>
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

        yield* adapter.post(ref, "On it <!channel>");
        assert.strictEqual(slack.messages[1]!.text, "On it &lt;!channel&gt;");
        assert.strictEqual(slack.messages[1]!.threadTs, ts);

        const history = yield* adapter.read(ref, 10);
        assert.deepStrictEqual(
          history.map((entry) => [entry.author, entry.fromUser]),
          [
            ["you", true],
            ["a bot", false],
          ],
        );

        const message = yield* adapter.showProgress({
          ref,
          message: null,
          progress: { title: "Fix it", steps: [], finished: null },
        });
        yield* adapter.showProgress({
          ref,
          message,
          progress: {
            title: "Fix it",
            steps: [{ id: "s1", text: "Write the fix", status: "completed" }],
            finished: { outcome: "completed", result: "Done." },
          },
        });
        const progress = slack.messages[2]!;
        yield* Effect.promise(() => slack.until(() => progress.edits === 1, 3000));
        assert.deepStrictEqual(
          progress.blocks?.map((block) => block.type),
          ["section", "task_card", "rich_text"],
        );
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    ),
  );

  it.live("asks for approval with buttons, and reads Approve and the Change form as answers", () =>
    withSlack((slack) =>
      Effect.gen(function* () {
        const { adapter, events } = yield* connect(slack);
        const ts = slack.say({ user: "UME", channel: "DME", text: "plan it", dm: true });
        const asked = yield* adapter.askApproval({
          ref: `slack:DME:${ts}`,
          askId: "plan:t:p",
          title: "Add CSV export",
          text: "1. Add a [link](http://x)",
        });
        const plan = slack.messages[1]!;
        assert.strictEqual(asked, `slack:DME:${plan.ts}`);
        assert.strictEqual(plan.blocks?.[1]?.text, "1. Add a \\[link](http://x)");

        slack.click({ user: "UME", channel: "DME", ts: plan.ts, actionId: APPROVE_ACTION });
        const triggerId = slack.click({
          user: "UME",
          channel: "DME",
          ts: plan.ts,
          actionId: CHANGE_ACTION,
        });
        yield* Effect.promise(() =>
          slack.until(() => slack.calls.some((call) => call.method === "views.open")),
        );
        slack.submit({ user: "UME", triggerId, text: "also JSON" });
        yield* Effect.promise(() => slack.until(() => events.length >= 3));
        assert.deepStrictEqual(
          events
            .slice(1)
            .map((event) =>
              event.type === "answer"
                ? [event.askId, event.message, event.decision, event.text]
                : null,
            ),
          [
            ["plan:t:p", asked, "approve", ""],
            ["plan:t:p", asked, "change", "also JSON"],
          ],
        );

        yield* adapter.closeApproval({
          message: asked,
          title: "Add CSV export",
          text: "1. Add it",
          outcome: "You approved it.",
        });
        assert.deepStrictEqual(
          plan.blocks?.map((block) => block.type),
          ["section", "markdown", "context"],
        );
      }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer)),
    ),
  );
});
