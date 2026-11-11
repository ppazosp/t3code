import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  ChannelAdapter,
  ChannelEvent,
  ChannelHistoryEntry,
  ChannelMessage,
} from "./Channel.ts";
import * as ChannelBridge from "./ChannelBridge.ts";

const ORIGIN = "slack:C1:1700000000.000100";

const thread = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  projectId: "project:1",
  title: id === "router" ? "Router" : "Fix the export",
  tags: [] as Array<string>,
  interactionMode: "default",
  archivedAt: null,
  deletedAt: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  ...fields,
});

const threadEvent = (fields: Record<string, unknown>) =>
  ({ type: "thread.tags-updated", threadId: "task", payload: thread("task", fields) }) as never;

const runEvent = (
  type: "run.created" | "run.updated",
  status: string,
  runId = "run:1",
  threadId = "task",
) => ({ type, threadId, runId, payload: { id: runId, threadId, status } }) as never;

const itemEvent = (payload: Record<string, unknown>, runId = "run:1", threadId = "task") =>
  ({ type: "turn-item.updated", threadId, runId, payload }) as never;

const message = (id: string, fields: Partial<ChannelMessage> = {}): ChannelEvent => ({
  type: "message",
  id,
  ref: ORIGIN,
  fromUser: true,
  direct: true,
  where: "#eng",
  author: "you",
  text: "address Miguel's feedback",
  ...fields,
});

const entry = (id: string, author: string, text: string, bot = false): ChannelHistoryEntry => ({
  id,
  author,
  fromUser: author === "you",
  bot,
  text,
});

/** Runs the bridge over scripted channel events and T3 events, recording what it does. */
function runBridge(input: {
  readonly channel?: ReadonlyArray<ChannelEvent>;
  readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly existing?: ReadonlyArray<ReturnType<typeof thread>>;
  readonly history?: ReadonlyArray<ChannelHistoryEntry>;
  readonly state?: ChannelBridge.BridgeState;
}) {
  const posts: Array<{ ref: string; text: string }> = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const marks: Array<[string, string]> = [];
  const statuses: Array<[string, string]> = [];
  const dispatched: Array<Record<string, unknown>> = [];
  const stopped: Array<string> = [];
  const adapter: ChannelAdapter = {
    name: "slack",
    prefix: "slack:",
    events: Stream.fromIterable(input.channel ?? []),
    fileLimit: 0,
    post: (ref, post) =>
      Effect.sync(() => {
        posts.push({ ref, text: post.text });
        return `slack:C1:post-${posts.length}`;
      }),
    mark: (id, mark) => Effect.sync(() => void marks.push([id, mark])),
    status: (ref, status) => Effect.sync(() => void statuses.push([ref, status])),
    read: () => Effect.succeed(input.history ?? []),
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
  } as never;
  const engine = { streamDomainEvents: Stream.fromIterable(input.events ?? []) } as never;
  const state = input.state ?? ChannelBridge.makeState();
  return ChannelBridge.run({ adapters: [adapter], threads, engine, state }).pipe(
    Effect.as({ posts, sent, marks, statuses, dispatched, stopped, state }),
  );
}

const task = thread("task", { tags: [ORIGIN] });

describe("ChannelBridge", () => {
  it.effect("posts each run's answer where the task came from, with no message of its own", () =>
    Effect.gen(function* () {
      const { posts, statuses } = yield* runBridge({
        events: [
          // An accepted proposal's worker starts before it is tagged with where it came from.
          threadEvent({ tags: [] }),
          runEvent("run.created", "running"),
          threadEvent({ tags: [ORIGIN], title: "Add CSV export" }),
          itemEvent({ type: "assistant_message", text: "Working on it", streaming: true }),
          itemEvent({ type: "assistant_message", text: "Done: **CSV** works.", streaming: false }),
          runEvent("run.updated", "completed"),
          runEvent("run.created", "running", "run:2"),
          runEvent("run.updated", "interrupted", "run:2"),
        ],
      });
      assert.deepStrictEqual(
        posts.map((post) => post.text),
        ["Done: **CSV** works.", "Stopped."],
      );
      assert.deepStrictEqual(statuses, [
        [ORIGIN, "working"],
        [ORIGIN, "idle"],
        [ORIGIN, "working"],
        [ORIGIN, "idle"],
      ]);
    }),
  );

  it.effect("leaves a task's delegate_task children to it, and posts once they finish", () =>
    Effect.gen(function* () {
      const child = thread("child", {
        tags: [ORIGIN],
        lineage: { parentThreadId: "task", relationshipToParent: "subagent", rootThreadId: "task" },
      });
      const { posts, sent, statuses } = yield* runBridge({
        existing: [thread("router", { tags: ["router"] }), task, child],
        channel: [message("m1", { text: "use my browser" })],
        events: [
          runEvent("run.created", "running"),
          runEvent("run.created", "running", "run:c", "child"),
          itemEvent({ type: "assistant_message", text: "Started a child.", streaming: false }),
          runEvent("run.updated", "completed"),
          itemEvent({ type: "assistant_message", text: "Child result", streaming: false }, "run:c"),
          runEvent("run.updated", "completed", "run:c", "child"),
          runEvent("run.created", "running", "run:2"),
          itemEvent({ type: "assistant_message", text: "All done.", streaming: false }, "run:2"),
          runEvent("run.updated", "completed", "run:2"),
        ],
      });
      // The user's tag reaches the task, not the router, though its child carries the same origin.
      assert.deepStrictEqual(
        sent.map((call) => call.threadId),
        ["task"],
      );
      assert.deepStrictEqual(
        posts.map((post) => post.text),
        ["All done."],
      );
      // Still working while the child runs; idle only after the task's own answer.
      assert.deepStrictEqual(statuses, [
        [ORIGIN, "working"],
        [ORIGIN, "working"],
        [ORIGIN, "idle"],
      ]);
    }),
  );

  it.effect("posts a planning run's plan and waits for the user", () =>
    Effect.gen(function* () {
      const { posts, statuses } = yield* runBridge({
        existing: [thread("task", { tags: [ORIGIN], interactionMode: "plan" })],
        events: [
          runEvent("run.created", "running"),
          itemEvent({ type: "assistant_message", text: "Let me look.", streaming: false }),
          itemEvent({ type: "proposed_plan", markdown: "# Plan\n- do it", streaming: false }),
          runEvent("run.updated", "completed"),
        ],
      });
      assert.deepStrictEqual(posts.at(-1), {
        ref: ORIGIN,
        text: "# Plan\n- do it",
      });
      assert.deepStrictEqual(statuses.at(-1), [ORIGIN, "waiting"]);
    }),
  );

  it.effect("passes the user's tag to a task, with a count of what is new", () =>
    Effect.gen(function* () {
      const { sent, marks } = yield* runBridge({
        existing: [thread("router", { tags: ["router"] }), task],
        history: [
          entry("m1", "@Miguel", "The export drops the header row"),
          entry("m2", "a bot", "🛠️ **Fix the export**", true),
          entry("m3", "you", "good catch"),
          entry("m4", "you", "address Miguel's feedback"),
          entry("m5", "@Ana", "and quotes break it too"),
          entry("m6", "you", "and Ana's"),
        ],
        channel: [
          // Untagged, or someone else's tag: stays in the thread for now.
          message("m1", { fromUser: false, direct: false, author: "@Miguel" }),
          message("m3", { direct: false, text: "good catch" }),
          message("m5", { fromUser: false, direct: true, author: "@Ana" }),
          message("m4"),
          message("m6", { text: "and Ana's" }),
        ],
      });
      assert.deepStrictEqual(
        sent.map((call) => call.threadId),
        ["task", "task"],
      );
      const [first, second] = sent.map((call) => call.text);
      assert.include(
        first,
        "The user tagged you in your Slack thread:\n> address Miguel's feedback",
      );
      // Others' words are not passed on: the task reads them with channel_read if they matter.
      assert.include(first, "4 other messages came in there since you last read it");
      assert.include(first, "channel_read");
      assert.notInclude(first, "The export drops");
      // The second tag counts only what came after the first.
      assert.include(second, "1 other message came in there");
      assert.deepStrictEqual(marks, [
        ["m4", "seen"],
        ["m4", "done"],
        ["m6", "seen"],
        ["m6", "done"],
      ]);
    }),
  );

  it.effect("lets the user's answer to a plan take a planning task on to the work", () =>
    Effect.gen(function* () {
      const { dispatched, sent } = yield* runBridge({
        existing: [thread("task", { tags: [ORIGIN], interactionMode: "plan" })],
        channel: [message("m1", { text: "looks good, go" })],
      });
      assert.deepStrictEqual(
        dispatched.map((command) => [command.type, command.interactionMode]),
        [["thread.interaction-mode.set", "default"]],
      );
      assert.include(sent[0]!.text, "If the user approves your plan, implement it now.");
    }),
  );

  it.effect("sends messages outside a task's conversation to the router", () =>
    Effect.gen(function* () {
      const elsewhere = "slack:C1:1700000000.000900";
      const { sent, marks, statuses, state } = yield* runBridge({
        existing: [thread("router", { tags: ["router"] }), task],
        channel: [
          message("m1", { ref: elsewhere, text: "what changed today?" }),
          message("m2", {
            ref: elsewhere,
            fromUser: false,
            direct: false,
            author: "@Ana",
            text: "fyi",
          }),
        ],
      });
      assert.deepStrictEqual(
        sent.map((call) => call.threadId),
        ["router", "router"],
      );
      assert.match(
        sent[0]!.text,
        /^\[slack #eng from you to me ref=slack:C1:1700000000\.000900\]/u,
      );
      assert.deepStrictEqual(marks, [["m1", "seen"]]);
      assert.deepStrictEqual(statuses, [[elsewhere, "working"]]);
      assert.deepStrictEqual(state.waiting.get(elsewhere), ["m1"]);
      assert.isTrue(state.userRefs.has(elsewhere));
    }),
  );

  it.effect("stops a conversation's tasks on the user's stop, by message or Stop button", () =>
    Effect.gen(function* () {
      const { stopped, sent, statuses } = yield* runBridge({
        existing: [
          thread("router", { tags: ["router"] }),
          task,
          thread("other", { tags: [ORIGIN] }),
        ],
        channel: [
          message("m1", { text: "Stop!" }),
          message("m2", { text: "stop", fromUser: false, author: "@Ana" }),
          { type: "stop", ref: ORIGIN, fromUser: false },
          { type: "stop", ref: ORIGIN, fromUser: true },
        ],
      });
      assert.deepStrictEqual(stopped, ["task", "other", "task", "other"]);
      assert.deepStrictEqual(sent, []);
      assert.deepStrictEqual(statuses, [
        [ORIGIN, "idle"],
        [ORIGIN, "idle"],
      ]);
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
