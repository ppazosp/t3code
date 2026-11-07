import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type { ChannelAdapter, ChannelMessage, Progress } from "./Channel.ts";
import * as ChannelBridge from "./ChannelBridge.ts";

const ORIGIN = "slack:D1:1700000000.000100";

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

/** Runs the bridge over scripted channel messages and T3 events, recording what it does. */
function runBridge(input: {
  readonly messages?: ReadonlyArray<ChannelMessage>;
  readonly events?: ReadonlyArray<OrchestrationV2DomainEvent>;
  readonly existing?: ReadonlyArray<ReturnType<typeof thread>>;
}) {
  const posts: Array<{ ref: string; text: string }> = [];
  const progress: Array<{ ref: string; message: string | null; progress: Progress }> = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const adapter: ChannelAdapter = {
    prefix: "slack:",
    messages: Stream.fromIterable(input.messages ?? []),
    post: (ref, text) => Effect.sync(() => void posts.push({ ref, text })),
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
  } as never;
  const engine = { streamDomainEvents: Stream.fromIterable(input.events ?? []) } as never;
  return ChannelBridge.run({ adapters: [adapter], threads, engine, userRefs: new Set() }).pipe(
    Effect.as({ posts, progress, sent }),
  );
}

describe("ChannelBridge", () => {
  it.effect("reports each run of a worker the user asked for, with its steps and result", () =>
    Effect.gen(function* () {
      const { posts, progress } = yield* runBridge({
        events: [
          // An accepted proposal's worker starts before it is tagged with where it came from.
          threadEvent({ tags: [] }),
          runEvent("run.created", "running"),
          threadEvent({ tags: [ORIGIN, "from-you"] }),
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
        progress.map((call) => [call.message, call.progress.steps.length, call.progress.finished]),
        [
          [null, 0, null],
          ["slack:D1:1700000000.000200", 1, null],
          ["slack:D1:1700000000.000200", 1, { outcome: "completed", result: "Fixed and pushed." }],
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
    "sends the user's reply where one task came from to that task, and the rest to the router",
    () =>
      Effect.gen(function* () {
        const message = (ref: string, fromUser = true): ChannelMessage => ({
          id: `slack:D1:${ref}`,
          ref,
          fromUser,
          where: "dm",
          author: fromUser ? "you" : "@U2",
          text: "also handle CSV",
        });
        const { sent } = yield* runBridge({
          existing: [thread("router", { tags: ["router"] }), thread("task", { tags: [ORIGIN] })],
          messages: [
            message(ORIGIN),
            message(ORIGIN, false),
            message("slack:D1:1700000000.000900"),
          ],
        });
        assert.deepStrictEqual(
          sent.map((call) => call.threadId),
          ["task", "router", "router"],
        );
        assert.strictEqual(sent[0]!.text, "also handle CSV");
      }),
  );
});
