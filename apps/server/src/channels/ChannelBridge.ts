import {
  type ChatAttachment,
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { ChannelAdapter, ChannelError, ChannelEvent, ChannelMessage } from "./Channel.ts";
import {
  isRouter,
  isStop,
  reportTarget,
  resultText,
  routerMessageText,
  taskMessageText,
  tasksFrom,
  type BridgeThread,
} from "./bridge.ts";
import { IMAGE_LIMIT, IMAGES_PER_MESSAGE, type ImageBytes } from "./images.ts";

const ACTIVE_RUN = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** How a finished run ended, for its post; a rolled-back run counts as stopped. */
const OUTCOME: Partial<
  Record<OrchestrationV2Run["status"], "completed" | "failed" | "interrupted">
> = {
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  rolled_back: "interrupted",
};

const LIMIT = 500;

const imageNote = (missed: number) =>
  missed <= 0
    ? ""
    : `\n\n${missed === 1 ? "1 image" : `${missed} images`} posted with this message could not be read.`;

/** How far back a tag reads its conversation. */
const THREAD_READ_LIMIT = 100;

type ThreadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;
const isThreadEvent = (event: OrchestrationV2DomainEvent): event is ThreadEvent =>
  event.type.startsWith("thread.") && event.type !== "thread.pull-request-link-updated";

export const toBridgeThread = (
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "projectId"
    | "title"
    | "tags"
    | "interactionMode"
    | "archivedAt"
    | "deletedAt"
    | "lineage"
  >,
): BridgeThread => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  tags: thread.tags ?? [],
  interactionMode: thread.interactionMode,
  archived: thread.archivedAt !== null || thread.deletedAt !== null,
  parentId:
    thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null,
});

/** What the bridge and the channel tools share. */
export interface BridgeState {
  /** Conversations the user wrote in; the router may answer only there. */
  readonly userRefs: Set<string>;
  /** The user's requests to the router not yet answered, by conversation: they show 👀 until then. */
  readonly waiting: Map<string, Array<string>>;
  /** Conversations the router proposed work for since the user last wrote: that is the answer. */
  readonly proposed: Set<string>;
}

export const makeState = (): BridgeState => ({
  userRefs: new Set(),
  waiting: new Map(),
  proposed: new Set(),
});

const remember = <K, V>(map: Map<K, V>, key: K, value: V) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > LIMIT) map.delete(map.keys().next().value!);
};

/** Marks the user's waiting requests in a conversation as handled, once something answered them. */
export const markHandled = Effect.fn("ChannelBridge.markHandled")(function* (
  state: BridgeState,
  adapter: ChannelAdapter,
  ref: string,
) {
  const waiting = state.waiting.get(ref) ?? [];
  state.waiting.delete(ref);
  for (const messageId of waiting) {
    yield* adapter
      .mark(messageId, "done")
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not mark a message handled", { cause }),
        ),
      );
  }
  yield* setStatus(adapter, ref, "idle");
});

const setStatus = (adapter: ChannelAdapter, ref: string, status: "working" | "idle" | "waiting") =>
  adapter
    .status(ref, status)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not show a conversation's status", { cause }),
      ),
    );

/** What T3 says, once per conversation, to anyone but the user who writes to it directly. */
export const OUTSIDER_NOTE =
  "This super-t3 works only for the person who set it up, so it did not act on your message.";

/** One run of a task, posting its result where the task came from when it ends. */
interface RunReport {
  readonly adapter: ChannelAdapter;
  readonly ref: string;
  readonly threadId: string;
  result: string | null;
  plan: string | null;
}

/**
 * Connects channels to T3. A conversation a task came from is that task's: only the user's tag
 * reaches it there, carrying everything said since the last tag; nothing in it goes to the router.
 * Every other message goes to the router. Back in the channel, a task posts each run's answer, plan
 * or question; a run that ends to wait for the task's children posts nothing.
 */
export const run = Effect.fn("ChannelBridge.run")(function* (input: {
  readonly adapters: ReadonlyArray<ChannelAdapter>;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly engine: Orchestrator.OrchestratorV2["Service"];
  readonly state: BridgeState;
  /** Stores a message's images as attachments of a message in a thread. */
  readonly saveImages: (
    threadId: string,
    messageId: string,
    images: ReadonlyArray<ImageBytes>,
  ) => Effect.Effect<ReadonlyArray<ChatAttachment>, ChannelError>;
}) {
  const { adapters, threads, engine, state } = input;
  const prefixes = adapters.map((adapter) => adapter.prefix);
  const adapterFor = (ref: string) => adapters.find((adapter) => ref.startsWith(adapter.prefix));

  const known = new Map<string, BridgeThread>();
  for (const shell of yield* threads
    .listProjectThreads({ includeSubagents: false })
    .pipe(Effect.orElseSucceed(() => []))) {
    const thread = toBridgeThread(shell);
    known.set(thread.id, thread);
  }
  const reports = new Map<string, RunReport>();
  // The run each thread is on, so a worker tagged after its run started is still reported.
  const activeRuns = new Map<string, string>();
  // The message each task last read up to in its conversation.
  const lastRead = new Map<string, string>();

  const mark = (adapter: ChannelAdapter, messageId: string, value: "seen" | "done") =>
    adapter
      .mark(messageId, value)
      .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not mark a message", { cause })));

  const stop = Effect.fn("ChannelBridge.stop")(function* (
    adapter: ChannelAdapter,
    ref: string,
    key: string,
    tasks: ReadonlyArray<BridgeThread>,
  ) {
    for (const task of tasks) {
      yield* threads
        .interruptThread({
          projectId: task.projectId as OrchestrationV2ThreadShell["projectId"],
          commandId: CommandId.make(`${key}:stop:${task.id}`),
          threadId: task.id as OrchestrationV2ThreadShell["id"],
          reason: "The user said stop in the channel.",
        })
        .pipe(Effect.catchCause((cause) => Effect.logWarning("Could not stop a task", { cause })));
    }
    yield* setStatus(adapter, ref, "idle");
  });

  /**
   * The images posted with a message, as attachments of a message in `threadId`, and a note for
   * the thread when some could not be read.
   */
  const attach = Effect.fn("ChannelBridge.attach")(function* (
    adapter: ChannelAdapter,
    message: ChannelMessage,
    threadId: string,
  ) {
    const posted = message.images ?? [];
    const fetched = yield* Effect.forEach(
      posted.slice(0, IMAGES_PER_MESSAGE),
      (image) =>
        adapter.image(image, IMAGE_LIMIT).pipe(
          Effect.map((bytes) => [{ name: image.name, mimeType: image.mimeType, bytes }]),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not fetch a channel image", { cause }).pipe(Effect.as([])),
          ),
        ),
      { concurrency: 2 },
    );
    const attachments = yield* input
      .saveImages(threadId, message.id, fetched.flat())
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not save channel images", { cause }).pipe(
            Effect.as([] as ReadonlyArray<ChatAttachment>),
          ),
        ),
      );
    return { attachments, note: imageNote(posted.length - attachments.length) };
  });

  /** The user's tag in a task's conversation, with everything said there since the last one. */
  const deliverToTask = Effect.fn("ChannelBridge.deliverToTask")(function* (
    adapter: ChannelAdapter,
    message: ChannelMessage,
    task: BridgeThread,
  ) {
    yield* mark(adapter, message.id, "seen");
    const history = yield* adapter
      .read(message.ref, THREAD_READ_LIMIT)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read a task's conversation", { cause }).pipe(
            Effect.as([] as ReadonlyArray<never>),
          ),
        ),
      );
    const from = lastRead.get(task.id);
    const index = from === undefined ? -1 : history.findIndex((entry) => entry.id === from);
    const since = (index === -1 ? history : history.slice(index + 1)).filter(
      (entry) => !entry.bot && entry.id !== message.id,
    );
    const planning = task.interactionMode === "plan";
    const threadId = task.id as OrchestrationV2ThreadShell["id"];
    // A planning task answered by the user goes on to do the work, or to plan again.
    if (planning) {
      yield* threads.dispatch({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(`${message.id}:mode`),
        threadId,
        interactionMode: "default",
      });
    }
    const { attachments, note } = yield* attach(adapter, message, task.id);
    yield* threads.sendToThread({
      projectId: task.projectId as OrchestrationV2ThreadShell["projectId"],
      commandId: CommandId.make(message.id),
      threadId,
      messageId: MessageId.make(message.id),
      text:
        taskMessageText({
          channel: adapter.name,
          text: message.text,
          unread: since.length,
          planning,
        }) + note,
      attachments,
      mode: "auto",
      createdBy: "user",
      creationSource: "server",
    });
    remember(lastRead, task.id, message.id);
    yield* mark(adapter, message.id, "done");
  });

  const deliver = Effect.fn("ChannelBridge.deliver")(
    function* (adapter: ChannelAdapter, message: ChannelMessage) {
      const request = message.fromUser && message.direct;
      const tasks = tasksFrom(message.ref, known.values(), prefixes);
      if (tasks.length > 0) {
        // A task's conversation is the task's: until the user tags it, messages stay there.
        if (!request) return;
        if (isStop(message)) {
          yield* mark(adapter, message.id, "seen");
          yield* stop(adapter, message.ref, message.id, tasks);
          return yield* mark(adapter, message.id, "done");
        }
        // With several tasks from one conversation, the router decides which one it is for.
        if (tasks.length === 1) return yield* deliverToTask(adapter, message, tasks[0]!);
      }
      const router = [...known.values()].find((thread) => !thread.archived && isRouter(thread));
      if (router === undefined) {
        yield* Effect.logWarning(
          "A channel message arrived, but no thread is tagged as the router.",
        );
        return;
      }
      // 👀 straight away, before any model runs, and the router shown working until it answers.
      if (request) {
        yield* mark(adapter, message.id, "seen");
        yield* setStatus(adapter, message.ref, "working");
      }
      const { attachments, note } = yield* attach(adapter, message, router.id);
      yield* threads.sendToThread({
        projectId: router.projectId as OrchestrationV2ThreadShell["projectId"],
        // The message's own id, so a redelivered message is the same command.
        commandId: CommandId.make(message.id),
        threadId: router.id as OrchestrationV2ThreadShell["id"],
        messageId: MessageId.make(message.id),
        text: routerMessageText(adapter.name, message) + note,
        attachments,
        mode: "auto",
        createdBy: message.fromUser ? "user" : "system",
        creationSource: "server",
      });
      if (!message.fromUser) return;
      state.proposed.delete(message.ref);
      state.userRefs.delete(message.ref);
      state.userRefs.add(message.ref);
      if (state.userRefs.size > LIMIT) state.userRefs.delete(state.userRefs.values().next().value!);
      if (request) {
        remember(state.waiting, message.ref, [
          ...(state.waiting.get(message.ref) ?? []),
          message.id,
        ]);
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not pass on a channel message", { cause }),
    ),
  );

  // Conversations already told that T3 works only for the user.
  const toldOutsiders = new Set<string>();
  const onChannelEvent = Effect.fn("ChannelBridge.onChannelEvent")(
    function* (adapter: ChannelAdapter, event: ChannelEvent) {
      if (event.type === "message") return yield* deliver(adapter, event);
      if (event.type === "stop") {
        if (!event.fromUser) return;
        return yield* stop(
          adapter,
          event.ref,
          `${event.ref}:stop-button`,
          tasksFrom(event.ref, known.values(), prefixes),
        );
      }
      if (toldOutsiders.has(event.ref)) return;
      toldOutsiders.add(event.ref);
      if (toldOutsiders.size > LIMIT) toldOutsiders.delete(toldOutsiders.values().next().value!);
      yield* adapter.post(event.ref, { text: OUTSIDER_NOTE });
      yield* setStatus(adapter, event.ref, "idle");
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not handle a channel event", { cause })),
  );

  /** Starts following a thread's run, once the thread is a task with a conversation to post in. */
  const startReport = Effect.fn("ChannelBridge.startReport")(function* (
    thread: BridgeThread,
    runId: string,
  ) {
    if (reports.has(runId)) return;
    const ref = reportTarget(thread, prefixes);
    const adapter = ref === null ? undefined : adapterFor(ref);
    if (ref === null || adapter === undefined) return;
    reports.set(runId, { adapter, ref, threadId: thread.id, result: null, plan: null });
    // The task says in its own words that it started, if it will take a while.
    yield* setStatus(adapter, ref, "working");
  });

  /** A task's delegate_task children still running: their completion wakes it to report. */
  const childrenRunning = (threadId: string) =>
    [...known.values()].some((thread) => thread.parentId === threadId && activeRuns.has(thread.id));

  const onRun = Effect.fn("ChannelBridge.onRun")(function* (runRecord: OrchestrationV2Run) {
    const report = reports.get(runRecord.id);
    if (report === undefined) {
      if (!ACTIVE_RUN.has(runRecord.status)) {
        if (activeRuns.get(runRecord.threadId) === runRecord.id) {
          activeRuns.delete(runRecord.threadId);
        }
        return;
      }
      activeRuns.set(runRecord.threadId, runRecord.id);
      const thread = known.get(runRecord.threadId);
      if (thread !== undefined) yield* startReport(thread, runRecord.id);
      return;
    }
    const outcome = OUTCOME[runRecord.status];
    if (outcome === undefined) return;
    reports.delete(runRecord.id);
    activeRuns.delete(runRecord.threadId);
    // A turn that ends to wait for its children is not an answer: it reports once they finish.
    if (outcome === "completed" && childrenRunning(runRecord.threadId)) return;
    // A plan is what a planning run ends with; it goes out like any answer, for the user to answer.
    const text = resultText(outcome, report.plan ?? report.result);
    if (text !== null) yield* report.adapter.post(report.ref, { text });
    const waitsForUser =
      outcome === "completed" && known.get(runRecord.threadId)?.interactionMode === "plan";
    yield* setStatus(report.adapter, report.ref, waitsForUser ? "waiting" : "idle");
  });

  const onEvent = Effect.fn("ChannelBridge.onEvent")(
    function* (event: OrchestrationV2DomainEvent) {
      if (isThreadEvent(event)) {
        const thread = toBridgeThread(event.payload);
        known.set(thread.id, thread);
        // An accepted proposal's worker is tagged with where it came from after its run started.
        const runId = activeRuns.get(thread.id);
        if (runId !== undefined && !reports.has(runId)) yield* startReport(thread, runId);
        return;
      }
      if (event.type === "run.created" || event.type === "run.updated") {
        yield* onRun(event.payload);
        return;
      }
      if (event.type !== "turn-item.updated" || event.runId === undefined) return;
      const report = reports.get(event.runId);
      if (report === undefined) return;
      const item = event.payload;
      if (item.type === "assistant_message" && !item.streaming) report.result = item.text;
      else if (item.type === "proposed_plan" && !item.streaming) report.plan = item.markdown;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not report a task in its channel", { cause }),
    ),
  );

  yield* Effect.all(
    [
      ...adapters.map((adapter) =>
        Stream.runForEach(adapter.events, (event) => onChannelEvent(adapter, event)),
      ),
      Stream.runForEach(engine.streamDomainEvents, onEvent),
    ],
    { concurrency: "unbounded", discard: true },
  );
});
