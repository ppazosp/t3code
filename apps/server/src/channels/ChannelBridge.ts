import {
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
import { routerMessageText } from "./slack/parse.ts";
import type { ChannelAdapter, ChannelMessage, Progress, ProgressStep } from "./Channel.ts";
import {
  announceTarget,
  isProposal,
  isRouter,
  progressSteps,
  proposalNote,
  reportTarget,
  taskForMessage,
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

type ThreadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly payload: OrchestrationV2AppThread }
>;
const isThreadEvent = (event: OrchestrationV2DomainEvent): event is ThreadEvent =>
  event.type.startsWith("thread.") && event.type !== "thread.pull-request-link-updated";

const toBridgeThread = (
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

/** One approved run being reported in its channel. */
interface RunReport {
  readonly adapter: ChannelAdapter;
  readonly ref: string;
  readonly message: string;
  readonly title: string;
  steps: ReadonlyArray<ProgressStep>;
  result: string | null;
}

/**
 * Connects channels to T3. A message goes to the router, or, when the user replies where exactly one
 * task came from, to that task. T3's events flow back: a proposal from a channel is announced
 * there, and each run of an approved task shows its progress and result there.
 */
export const run = Effect.fn("ChannelBridge.run")(function* (input: {
  readonly adapters: ReadonlyArray<ChannelAdapter>;
  readonly threads: ThreadManagementService.ThreadManagementService["Service"];
  readonly engine: Orchestrator.OrchestratorV2["Service"];
  /** Conversations the user wrote in; the router may answer only there. */
  readonly userRefs: Set<string>;
}) {
  const { adapters, threads, engine, userRefs } = input;
  const prefixes = adapters.map((adapter) => adapter.prefix);
  const adapterFor = (ref: string) => adapters.find((adapter) => ref.startsWith(adapter.prefix));

  const known = new Map<string, BridgeThread>();
  const announced = new Set<string>();
  for (const shell of yield* threads
    .listProjectThreads({ includeSubagents: false })
    .pipe(Effect.orElseSucceed(() => []))) {
    const thread = toBridgeThread(shell);
    known.set(thread.id, thread);
    // Proposals from before a restart were announced already.
    if (isProposal(thread)) announced.add(thread.id);
  }
  const reports = new Map<string, RunReport>();

  const deliver = Effect.fn("ChannelBridge.deliver")(
    function* (message: ChannelMessage) {
      const task = taskForMessage(message, known.values(), prefixes);
      const target =
        task ?? [...known.values()].find((thread) => !thread.archived && isRouter(thread));
      if (target === undefined) {
        yield* Effect.logWarning(
          "A channel message arrived, but no thread is tagged as the router.",
        );
        return;
      }
      yield* threads.sendToThread({
        projectId: target.projectId as OrchestrationV2ThreadShell["projectId"],
        // The message's own id, so a redelivered message is the same command.
        commandId: CommandId.make(message.id),
        threadId: target.id as OrchestrationV2ThreadShell["id"],
        messageId: MessageId.make(message.id),
        // A task gets the user's words; the router gets them with where they came from.
        text: task === null ? routerMessageText(message) : message.text,
        attachments: [],
        mode: "auto",
        createdBy: message.fromUser ? "user" : "system",
        creationSource: "server",
      });
      if (task === null && message.fromUser) {
        userRefs.add(message.ref);
        if (userRefs.size > 500) userRefs.delete(userRefs.values().next().value!);
      }
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not pass on a channel message", { cause }),
    ),
  );

  const show = (report: RunReport, finished: Progress["finished"]) =>
    report.adapter.showProgress({
      ref: report.ref,
      message: report.message,
      progress: { title: report.title, steps: report.steps, finished },
    });

  const onRun = Effect.fn("ChannelBridge.onRun")(function* (runRecord: OrchestrationV2Run) {
    const report = reports.get(runRecord.id);
    if (report === undefined) {
      const thread = known.get(runRecord.threadId);
      if (thread === undefined || !ACTIVE_RUN.has(runRecord.status)) return;
      const ref = reportTarget(thread, prefixes);
      const adapter = ref === null ? undefined : adapterFor(ref);
      if (ref === null || adapter === undefined) return;
      const progress: Progress = { title: thread.title, steps: [], finished: null };
      const message = yield* adapter.showProgress({ ref, message: null, progress });
      reports.set(runRecord.id, {
        adapter,
        ref,
        message,
        title: thread.title,
        steps: [],
        result: null,
      });
      return;
    }
    const outcome = OUTCOME[runRecord.status];
    if (outcome === undefined) return;
    reports.delete(runRecord.id);
    yield* show(report, { outcome, result: report.result });
  });

  const onEvent = Effect.fn("ChannelBridge.onEvent")(
    function* (event: OrchestrationV2DomainEvent) {
      if (isThreadEvent(event)) {
        const thread = toBridgeThread(event.payload);
        known.set(thread.id, thread);
        const origin = announceTarget(thread, prefixes);
        const adapter = origin === null ? undefined : adapterFor(origin);
        if (
          origin !== null &&
          adapter !== undefined &&
          isProposal(thread) &&
          !announced.has(thread.id)
        ) {
          announced.add(thread.id);
          yield* adapter.post(origin, proposalNote(thread.title));
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
      Stream.runForEach(
        Stream.mergeAll(
          adapters.map((adapter) => adapter.messages),
          { concurrency: "unbounded" },
        ),
        deliver,
      ),
      Stream.runForEach(engine.streamDomainEvents, onEvent),
    ],
    { concurrency: "unbounded", discard: true },
  );
});
