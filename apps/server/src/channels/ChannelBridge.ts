import {
  CommandId,
  MessageId,
  PlanId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type {
  ChannelAdapter,
  ChannelAnswer,
  ChannelEvent,
  ChannelMessage,
  Progress,
  ProgressStep,
} from "./Channel.ts";
import {
  isRouter,
  isStop,
  planChangeText,
  progressSteps,
  reportTarget,
  routerMessageText,
  taskForMessage,
  taskMessageText,
  tasksFrom,
  type BridgeThread,
} from "./bridge.ts";

const ACTIVE_RUN = new Set<OrchestrationV2Run["status"]>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/** How a finished run shows in a channel; a rolled-back run counts as stopped. */
const OUTCOME: Partial<
  Record<OrchestrationV2Run["status"], NonNullable<Progress["finished"]>["outcome"]>
> = {
  completed: "completed",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "interrupted",
  rolled_back: "interrupted",
};

/** T3's own words for implementing a plan, as its Implement button sends them. */
const IMPLEMENT_PLAN_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

const LIMIT = 500;

type ThreadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;
const isThreadEvent = (event: OrchestrationV2DomainEvent): event is ThreadEvent =>
  event.type.startsWith("thread.") && event.type !== "thread.pull-request-link-updated";

export const toBridgeThread = (
  thread: Pick<
    OrchestrationV2ThreadShell,
    "id" | "projectId" | "title" | "tags" | "interactionMode" | "archivedAt" | "deletedAt"
  >,
): BridgeThread => ({
  id: thread.id,
  projectId: thread.projectId,
  title: thread.title,
  tags: thread.tags ?? [],
  interactionMode: thread.interactionMode,
  archived: thread.archivedAt !== null || thread.deletedAt !== null,
});

/** What the bridge and the channel tools share. */
export interface BridgeState {
  /** Conversations the user wrote in; the router may answer only there. */
  readonly userRefs: Set<string>;
  /** The user's requests to the router not yet answered, by conversation: they show 👀 until then. */
  readonly waiting: Map<string, Array<string>>;
  /** Conversations where T3 posted a proposal since the user last wrote: that is the answer. */
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

/** One approved run being reported in its channel. */
interface RunReport {
  readonly adapter: ChannelAdapter;
  readonly ref: string;
  readonly threadId: string;
  readonly message: string;
  title: string;
  steps: ReadonlyArray<ProgressStep>;
  result: string | null;
}

/** A plan waiting in a channel for the user's answer; thread ids can hold colons, so it is JSON. */
const AskId = Schema.fromJsonString(
  Schema.Tuple([Schema.Literal("plan"), Schema.String, Schema.String]),
);
const encodeAskId = Schema.encodeSync(AskId);
const decodeAskId = Schema.decodeUnknownOption(AskId);
const askIdOf = (threadId: string, planId: string) => encodeAskId(["plan", threadId, planId]);
const readAskId = (askId: string) =>
  Option.match(decodeAskId(askId), {
    onNone: () => null,
    onSome: ([, threadId, planId]) => ({ threadId, planId }),
  });

/**
 * Connects channels to T3. A message goes to the router, or, when the user writes where exactly one
 * worker came from, to that worker; "stop" there stops it. T3's events flow back: each run of a
 * worker the user asked for in a channel shows its progress, its plan for approval and its result
 * there.
 */
export const run = Effect.fn("ChannelBridge.run")(function* (input: {
  readonly adapters: ReadonlyArray<ChannelAdapter>;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly engine: Orchestrator.OrchestratorV2["Service"];
  readonly state: BridgeState;
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
  // Plans already answered, so a second click cannot start the work twice.
  const answered = new Set<string>();

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

  const deliver = Effect.fn("ChannelBridge.deliver")(
    function* (adapter: ChannelAdapter, message: ChannelMessage) {
      const request = message.fromUser && message.direct;
      if (isStop(message)) {
        const tasks = tasksFrom(message.ref, known.values(), prefixes);
        if (tasks.length > 0) {
          yield* mark(adapter, message.id, "seen");
          yield* stop(adapter, message.ref, message.id, tasks);
          return yield* mark(adapter, message.id, "done");
        }
      }
      const task = taskForMessage(message, known.values(), prefixes);
      const target =
        task ?? [...known.values()].find((thread) => !thread.archived && isRouter(thread));
      if (target === undefined) {
        yield* Effect.logWarning(
          "A channel message arrived, but no thread is tagged as the router.",
        );
        return;
      }
      // 👀 straight away, before any model runs, and the router shown working until it answers.
      if (request) yield* mark(adapter, message.id, "seen");
      if (request && task === null) yield* setStatus(adapter, message.ref, "working");
      yield* threads.sendToThread({
        projectId: target.projectId as OrchestrationV2ThreadShell["projectId"],
        // The message's own id, so a redelivered message is the same command.
        commandId: CommandId.make(message.id),
        threadId: target.id as OrchestrationV2ThreadShell["id"],
        messageId: MessageId.make(message.id),
        // A task gets the user's words; the router gets them with where they came from.
        text:
          task === null
            ? routerMessageText(adapter.name, message)
            : taskMessageText(adapter.name, message.text),
        attachments: [],
        mode: "auto",
        createdBy: message.fromUser ? "user" : "system",
        creationSource: "server",
      });
      if (task !== null) {
        // The worker took it.
        yield* mark(adapter, message.id, "done");
        return;
      }
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

  /** The plan a thread proposed and still waits on, if `planId` is it. */
  const actionablePlan = Effect.fn("ChannelBridge.actionablePlan")(function* (
    threadId: string,
    planId: string | null,
  ) {
    const projection = yield* threads.getThreadProjection(ThreadId.make(threadId));
    if (projection.runs.some((candidate) => ACTIVE_RUN.has(candidate.status))) return null;
    const plan = projection.plans.findLast(
      (candidate) => candidate.kind === "proposed_plan" && candidate.status === "active",
    );
    if (plan === undefined || plan.kind !== "proposed_plan") return null;
    if (planId !== null && plan.id !== planId) return null;
    return { projection, plan };
  });

  const answer = Effect.fn("ChannelBridge.answer")(
    function* (adapter: ChannelAdapter, reply: ChannelAnswer) {
      // Only the user's answer counts, and only the first one.
      if (!reply.fromUser || answered.has(reply.askId)) return;
      const ask = readAskId(reply.askId);
      if (ask === null) return;
      const found = yield* actionablePlan(ask.threadId, ask.planId);
      const thread = known.get(ask.threadId);
      if (found === null || thread === undefined || reportTarget(thread, prefixes) === null) {
        yield* Effect.logInfo("A plan answer arrived for a plan no longer waiting.");
        return;
      }
      const { projection, plan } = found;
      const threadId = projection.thread.id;
      if (reply.decision === "approve") {
        yield* threads.dispatch({
          type: "thread.interaction-mode.set",
          commandId: CommandId.make(`${reply.askId}:mode`),
          threadId,
          interactionMode: "default",
        });
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`${reply.askId}:implement`),
          createdBy: "user",
          creationSource: "server",
          threadId,
          messageId: MessageId.make(`${reply.askId}:implement`),
          text: `${IMPLEMENT_PLAN_PREFIX}${plan.markdown.trim()}`,
          attachments: [],
          sourcePlanRef: { threadId, planId: PlanId.make(plan.id) },
          dispatchMode: { type: "start_immediately" },
        });
      } else {
        yield* threads.sendToThread({
          projectId: projection.thread.projectId,
          commandId: CommandId.make(`${reply.askId}:change`),
          threadId,
          messageId: MessageId.make(`${reply.askId}:change`),
          text: planChangeText(adapter.name, reply.text),
          attachments: [],
          mode: "auto",
          createdBy: "user",
          creationSource: "server",
        });
      }
      // Answered once the work is sent: answers arrive one at a time, and the new run makes the plan
      // stop waiting, so a second click finds nothing to answer either way.
      answered.add(reply.askId);
      if (answered.size > LIMIT) answered.delete(answered.values().next().value!);
      yield* adapter.closeApproval({
        message: reply.message,
        title: thread.title,
        text: plan.markdown,
        outcome:
          reply.decision === "approve"
            ? "You approved it. The worker is implementing the plan."
            : `You asked for changes: ${reply.text}`,
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not answer a plan", { cause })),
  );

  /** Posts the plan a run ended with, for the user to approve or change. */
  const askForPlan = Effect.fn("ChannelBridge.askForPlan")(
    function* (report: RunReport, runId: string) {
      const found = yield* actionablePlan(report.threadId, null);
      if (found === null || found.plan.runId !== runId) return false;
      const { plan } = found;
      if (!report.adapter.fits(plan.markdown)) {
        yield* report.adapter.post(
          report.ref,
          "The plan is too long to show here. Review it in T3 to approve it.",
        );
        return true;
      }
      yield* report.adapter.askApproval({
        ref: report.ref,
        askId: askIdOf(report.threadId, plan.id),
        title: report.title,
        text: plan.markdown,
      });
      return true;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not post a plan for approval", { cause }).pipe(Effect.as(false)),
    ),
  );

  // Conversations already told that T3 works only for the user.
  const toldOutsiders = new Set<string>();
  const onChannelEvent = Effect.fn("ChannelBridge.onChannelEvent")(
    function* (adapter: ChannelAdapter, event: ChannelEvent) {
      if (event.type === "message") return yield* deliver(adapter, event);
      if (event.type === "answer") return yield* answer(adapter, event);
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
      yield* adapter.post(event.ref, OUTSIDER_NOTE);
      yield* setStatus(adapter, event.ref, "idle");
    },
    Effect.catchCause((cause) => Effect.logWarning("Could not handle a channel event", { cause })),
  );

  const show = (report: RunReport, finished: Progress["finished"]) =>
    report.adapter.showProgress({
      ref: report.ref,
      message: report.message,
      progress: { title: report.title, steps: report.steps, finished },
    });

  /** Starts reporting a thread's active run, once the thread is one to report. */
  const startReport = Effect.fn("ChannelBridge.startReport")(function* (
    thread: BridgeThread,
    runId: string,
  ) {
    if (reports.has(runId)) return;
    const ref = reportTarget(thread, prefixes);
    const adapter = ref === null ? undefined : adapterFor(ref);
    if (ref === null || adapter === undefined) return;
    const progress: Progress = { title: thread.title, steps: [], finished: null };
    yield* setStatus(adapter, ref, "working");
    const message = yield* adapter.showProgress({ ref, message: null, progress });
    reports.set(runId, {
      adapter,
      ref,
      threadId: thread.id,
      message,
      title: thread.title,
      steps: [],
      result: null,
    });
  });

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
    yield* show(report, { outcome, result: report.result });
    const asked = outcome === "completed" ? yield* askForPlan(report, runRecord.id) : false;
    yield* setStatus(report.adapter, report.ref, asked ? "waiting" : "idle");
  });

  const onEvent = Effect.fn("ChannelBridge.onEvent")(
    function* (event: OrchestrationV2DomainEvent) {
      if (isThreadEvent(event)) {
        const thread = toBridgeThread(event.payload);
        known.set(thread.id, thread);
        // An accepted proposal's worker is tagged, and gets its title, after its run has started.
        const runId = activeRuns.get(thread.id);
        if (runId === undefined) return;
        const report = reports.get(runId);
        if (report === undefined) return yield* startReport(thread, runId);
        if (report.title !== thread.title) {
          report.title = thread.title;
          yield* show(report, null);
        }
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
      if (item.type === "todo_list") {
        report.steps = progressSteps(item.steps);
        yield* show(report, null);
      } else if (item.type === "assistant_message" && !item.streaming) {
        report.result = item.text;
      }
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
