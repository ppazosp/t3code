import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ChannelAdapter, ChannelEvent, ChannelMessage, Progress } from "./Channel.ts";
import * as ChannelBridge from "./ChannelBridge.ts";

const ORIGIN = "slack:D1:1700000000.000100";
const PLAN = JSON.stringify(["plan", "task", "plan-1"]);

const thread = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  projectId: "project:1",
  title: id === "router" ? "Router" : "Fix the export",
  tags: [] as Array<string>,
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
  ...fields,
});

const threadEvent = (fields: Record<string, unknown>) =>
  ({ type: "thread.tags-updated", threadId: "task", payload: thread("task", fields) }) as never;

const runEvent = (type: "run.created" | "run.updated", status: string, runId = "run:1") =>
  ({ type, threadId: "task", runId, payload: { id: runId, threadId: "task", status } }) as never;

const itemEvent = (payload: Record<string, unknown>, runId = "run:1") =>
  ({ type: "turn-item.updated", threadId: "task", runId, payload }) as never;

const message = (ref: string, fields: Partial<ChannelMessage> = {}): ChannelEvent => ({
  type: "message",
  id: `slack:D1:${ref.slice(-4)}${fields.text ?? ""}`,
  ref,
  fromUser: true,
  direct: true,
  where: "dm",
  author: "you",
  text: "also handle CSV",
  ...fields,
});

const answer = (fields: Partial<Extract<ChannelEvent, { type: "answer" }>> = {}): ChannelEvent => ({
  type: "answer",
  askId: PLAN,
  message: "slack:D1:1700000000.000300",
  fromUser: true,
  decision: "approve",
  text: "",
  ...fields,
});

const activePlan = {
  kind: "proposed_plan",
  id: "plan-1",
  runId: "run:1",
  status: "active",
  markdown: "# Plan\n- do it",
};

/** Runs the bridge over scripted channel events and T3 events, recording what it does. */
function runBridge(input: {
  readonly channel?: ReadonlyArray<ChannelEvent>;
  readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly existing?: ReadonlyArray<ReturnType<typeof thread>>;
  readonly plans?: ReadonlyArray<typeof activePlan>;
  readonly state?: ChannelBridge.BridgeState;
}) {
  const posts: Array<{ ref: string; text: string }> = [];
  const progress: Array<{ ref: string; message: string | null; progress: Progress }> = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const marks: Array<[string, string]> = [];
  const statuses: Array<[string, string]> = [];
  const asks: Array<{ ref: string; askId: string; text: string }> = [];
  const closed: Array<string> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const stopped: Array<string> = [];
  const adapter: ChannelAdapter = {
    name: "slack",
    prefix: "slack:",
    events: Stream.fromIterable(input.channel ?? []),
    post: (ref, text) => Effect.sync(() => void posts.push({ ref, text })),
    mark: (id, mark) => Effect.sync(() => void marks.push([id, mark])),
    status: (ref, status) => Effect.sync(() => void statuses.push([ref, status])),
    read: () => Effect.succeed([]),
    fits: (text) => text.length < 1000,
    askApproval: (call) =>
      Effect.sync(() => {
        asks.push(call);
        return "slack:D1:1700000000.000300";
      }),
    closeApproval: (call) => Effect.sync(() => void closed.push(call.outcome)),
    showProgress: (call) =>
      Effect.sync(() => {
        progress.push(call);
        return call.message ?? "slack:D1:1700000000.000200";
      }),
  };
  const threads = {
    listProjectThreads: () =>
      Effect.succeed(input.existing ?? [thread("router", { tags: ["router"] })]),
    sendToThread: (call: { threadId: string; text: string }) =>
      Effect.sync(() => void sent.push({ threadId: call.threadId, text: call.text })),
    interruptThread: (call: { threadId: string }) =>
      Effect.sync(() => {
        stopped.push(call.threadId);
        return { type: "no_active_run" };
      }),
    dispatch: (command: Record<string, unknown>) =>
      Effect.sync(() => void dispatched.push(command)),
    getThreadProjection: () =>
      Effect.succeed({
        thread: { id: "task", projectId: "project:1" },
        runs: [{ id: "run:1", status: "completed" }],
        plans: input.plans ?? [],
      }),
  } as never;
  const engine = { streamDomainEvents: Stream.fromIterable(input.events ?? []) } as never;
  const state = input.state ?? ChannelBridge.makeState();
  return ChannelBridge.run({ adapters: [adapter], threads, engine, state }).pipe(
    Effect.as({ posts, progress, sent, marks, statuses, asks, closed, dispatched, stopped, state }),
  );
}

const userTask = thread("task", { tags: [ORIGIN, "from-you"], interactionMode: "plan" });

describe("ChannelBridge", () => {
  it.effect("reports each run of a worker the user asked for, with its steps and result", () =>
    Effect.gen(function* () {
      const { posts, progress } = yield* runBridge({
        events: [
          // An accepted proposal's worker starts before it is tagged with where it came from.
          threadEvent({ tags: [] }),
          runEvent("run.created", "running"),
          threadEvent({ tags: [ORIGIN, "from-you"] }),
          threadEvent({ tags: [ORIGIN, "from-you"], title: "Add CSV export" }),
          itemEvent({
            type: "todo_list",
            steps: [{ id: "s1", text: "Write the fix", status: "running" }],
          }),
          itemEvent({ type: "assistant_message", text: "Fixed and pushed.", streaming: false }),
          runEvent("run.updated", "completed"),
        ],
      });
      assert.deepStrictEqual(posts, []);
      assert.deepStrictEqual(
        progress.map((call) => [
          call.message,
          call.progress.title,
          call.progress.steps.length,
          call.progress.finished,
        ]),
        [
          [null, "Fix the export", 0, null],
          ["slack:D1:1700000000.000200", "Add CSV export", 0, null],
          ["slack:D1:1700000000.000200", "Add CSV export", 1, null],
          [
            "slack:D1:1700000000.000200",
            "Add CSV export",
            1,
            { outcome: "completed", result: "Fixed and pushed." },
          ],
        ],
      );
    }),
  );

  it.effect("never reports a worker proposed from someone else's message", () =>
    Effect.gen(function* () {
      const { progress } = yield* runBridge({
        events: [
          threadEvent({ tags: [ORIGIN] }),
          runEvent("run.created", "running"),
          runEvent("run.updated", "completed"),
        ],
      });
      assert.deepStrictEqual(progress, []);
    }),
  );

  it.effect(
    "sends the user's request where one task came from to that task, and the rest to the router",
    () =>
      Effect.gen(function* () {
        const before = ChannelBridge.makeState();
        before.proposed.add(ORIGIN);
        const { sent, marks, state } = yield* runBridge({
          state: before,
          existing: [thread("router", { tags: ["router"] }), thread("task", { tags: [ORIGIN] })],
          channel: [
            message(ORIGIN),
            message(ORIGIN, { fromUser: false, author: "@U2", text: "me too" }),
            // In a channel, a reply without a mention is information for the router.
            message(ORIGIN, { direct: false, text: "fyi" }),
            message("slack:D1:1700000000.000900"),
          ],
        });
        assert.deepStrictEqual(
          sent.map((call) => call.threadId),
          ["task", "router", "router", "router"],
        );
        assert.include(sent[0]!.text, "The user wrote in your Slack thread:\n> also handle CSV");
        assert.include(sent[0]!.text, "channel_say");
        assert.match(sent[3]!.text, /^\[slack dm from you ref=slack:D1:1700000000\.000900\]/u);
        // The task took its message at once; the router's request waits for an answer.
        assert.deepStrictEqual(marks, [
          ["slack:D1:0100", "seen"],
          ["slack:D1:0100", "done"],
          ["slack:D1:0900", "seen"],
        ]);
        assert.deepStrictEqual(state.waiting.get("slack:D1:1700000000.000900"), ["slack:D1:0900"]);
        assert.isTrue(state.userRefs.has(ORIGIN));
        // The user wrote again, so the router may answer there again after a proposal.
        assert.isFalse(state.proposed.has(ORIGIN));
      }),
  );

  it.effect(
    "stops every task from the conversation when the user says stop, without the router",
    () =>
      Effect.gen(function* () {
        const { sent, stopped, marks } = yield* runBridge({
          existing: [
            thread("router", { tags: ["router"] }),
            thread("task", { tags: [ORIGIN] }),
            thread("other", { tags: [ORIGIN] }),
          ],
          channel: [
            message(ORIGIN, { text: "Stop!" }),
            // Someone else, or the user without a mention, cannot stop work.
            message(ORIGIN, { text: "stop", fromUser: false }),
            message(ORIGIN, { text: "stop", direct: false }),
          ],
        });
        assert.deepStrictEqual(stopped, ["task", "other"]);
        assert.deepStrictEqual(
          sent.map((call) => call.threadId),
          ["router", "router"],
        );
        assert.deepStrictEqual(marks.slice(0, 2), [
          ["slack:D1:0100Stop!", "seen"],
          ["slack:D1:0100Stop!", "done"],
        ]);
      }),
  );

  it.effect("posts the plan a reported run ended with, for the user to approve", () =>
    Effect.gen(function* () {
      const { asks } = yield* runBridge({
        existing: [userTask],
        plans: [activePlan],
        events: [runEvent("run.created", "running"), runEvent("run.updated", "completed")],
      });
      assert.deepStrictEqual(
        asks.map((ask) => [ask.ref, ask.askId, ask.text]),
        [[ORIGIN, PLAN, "# Plan\n- do it"]],
      );
    }),
  );

  it.effect("implements the plan on the user's approval, once", () =>
    Effect.gen(function* () {
      const { dispatched, closed } = yield* runBridge({
        existing: [userTask],
        plans: [activePlan],
        channel: [answer({ fromUser: false }), answer(), answer()],
      });
      assert.deepStrictEqual(
        dispatched.map((command) => command.type),
        ["thread.interaction-mode.set", "message.dispatch"],
      );
      assert.deepStrictEqual(dispatched[1]!.sourcePlanRef, { threadId: "task", planId: "plan-1" });
      assert.match(String(dispatched[1]!.text), /^PLEASE IMPLEMENT THIS PLAN:\n# Plan/u);
      assert.strictEqual(closed.length, 1);
    }),
  );

  it.effect("sends the user's changes to the worker, and ignores a plan no longer waiting", () =>
    Effect.gen(function* () {
      const changed = yield* runBridge({
        existing: [userTask],
        plans: [activePlan],
        channel: [answer({ decision: "change", text: "use CSV too" })],
      });
      assert.include(changed.sent[0]!.text, "> use CSV too");
      assert.deepStrictEqual(changed.closed, ["You asked for changes: use CSV too"]);

      const stale = yield* runBridge({
        existing: [userTask],
        plans: [{ ...activePlan, status: "superseded" }],
        channel: [answer()],
      });
      assert.deepStrictEqual([stale.dispatched, stale.closed], [[], []]);
    }),
  );

  it.effect(
    "shows the router working on the user's request, and a report's run until it ends",
    () =>
      Effect.gen(function* () {
        const asked = yield* runBridge({ channel: [message("slack:D1:1700000000.000900")] });
        assert.deepStrictEqual(asked.statuses, [["slack:D1:1700000000.000900", "working"]]);

        const reported = yield* runBridge({
          existing: [userTask],
          plans: [activePlan],
          events: [runEvent("run.created", "running"), runEvent("run.updated", "completed")],
        });
        // The run ended with a plan to approve, so the conversation waits for the user.
        assert.deepStrictEqual(reported.statuses, [
          [ORIGIN, "working"],
          [ORIGIN, "waiting"],
        ]);

        // A planning worker that asked a question instead of writing a plan also waits for the user.
        const questioned = yield* runBridge({
          existing: [userTask],
          events: [runEvent("run.created", "running"), runEvent("run.updated", "completed")],
        });
        assert.deepStrictEqual(questioned.statuses.at(-1), [ORIGIN, "waiting"]);
      }),
  );

  it.effect("stops a conversation's tasks from the channel's Stop button, only for the user", () =>
    Effect.gen(function* () {
      const { stopped, statuses, sent } = yield* runBridge({
        existing: [thread("router", { tags: ["router"] }), thread("task", { tags: [ORIGIN] })],
        channel: [
          { type: "stop", ref: ORIGIN, fromUser: false },
          { type: "stop", ref: ORIGIN, fromUser: true },
        ],
      });
      assert.deepStrictEqual(stopped, ["task"]);
      assert.deepStrictEqual(statuses, [[ORIGIN, "idle"]]);
      assert.deepStrictEqual(sent, []);
    }),
  );

  it.effect("tells anyone else once per conversation that it works only for the user", () =>
    Effect.gen(function* () {
      const { posts, sent } = yield* runBridge({
        channel: [
          { type: "outsider", ref: "slack:D2:1.1" },
          { type: "outsider", ref: "slack:D2:1.1" },
          { type: "outsider", ref: "slack:D2:2.2" },
        ],
      });
      assert.deepStrictEqual(
        posts.map((post) => [post.ref, post.text]),
        [
          ["slack:D2:1.1", ChannelBridge.OUTSIDER_NOTE],
          ["slack:D2:2.2", ChannelBridge.OUTSIDER_NOTE],
        ],
      );
      assert.deepStrictEqual(sent, []);
    }),
  );
});
