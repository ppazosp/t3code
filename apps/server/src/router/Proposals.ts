import {
  CommandId,
  FROM_USER_TAG,
  isProposalTask,
  PROPOSAL_RUN_AT,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ScheduledTaskId,
  type ServerProvider,
  type ThreadId,
  type ThreadTag,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Channels from "../channels/Channels.ts";
import { proposalNote } from "../channels/bridge.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";

export class ProposalError extends Schema.TaggedError<ProposalError>()("ProposalError", {
  message: Schema.String,
}) {}

const SLACK_HEADER = /^\[slack [^\]\n]* ref=(slack:[A-Z0-9]+:\d+\.\d+)\]$/u;

/** The Slack ref in a header the channel adapter wrote; quoted lines below it never count. */
export function slackOriginOf(text: string): string | null {
  const header = text.split("\n", 1)[0] ?? "";
  return SLACK_HEADER.exec(header)?.[1] ?? null;
}

/** Whether the header says the user wrote the message, as the channel adapter writes it. */
export function isFromUser(text: string): boolean {
  const header = text.split("\n", 1)[0] ?? "";
  return SLACK_HEADER.test(header) && /^\[slack \S+ from you ref=/u.test(header);
}

/**
 * The model's options as the model names them: the router guesses option ids, so only ids the model
 * has are kept, and `effort` is matched to its reasoning control by choice id or label.
 */
export function resolveModelOptions(
  selection: ModelSelection,
  effort: string | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((entry) => entry.slug === selection.model);
  const descriptors = model?.capabilities?.optionDescriptors ?? [];
  const known = new Set(descriptors.map((descriptor) => descriptor.id));
  const options = (selection.options ?? []).filter((option) => known.has(option.id));
  const reasoning = descriptors.find(
    (descriptor) =>
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" || descriptor.id === "reasoningEffort"),
  );
  // Routers often put effort among the options under a guessed name; read it back from there too.
  const guessedEffort = (selection.options ?? []).find(
    (option) => /effort|reasoning/iu.test(option.id) && typeof option.value === "string",
  )?.value;
  const wanted = (effort ?? (typeof guessedEffort === "string" ? guessedEffort : undefined))
    ?.trim()
    .toLowerCase();
  const choice =
    reasoning?.type === "select" && wanted
      ? reasoning.options.find(
          (option) => option.id.toLowerCase() === wanted || option.label.toLowerCase() === wanted,
        )
      : undefined;
  const resolved =
    reasoning === undefined || choice === undefined
      ? options
      : [
          ...options.filter((option) => option.id !== reasoning.id),
          { id: reasoning.id, value: choice.id },
        ];
  return { instanceId: selection.instanceId, model: selection.model, options: resolved };
}

export interface ProposeInput {
  readonly routerId: ThreadId;
  readonly title: string;
  readonly brief: string;
  readonly projectId: ProjectId;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  /** The router's own model when left out. */
  readonly modelSelection: ModelSelection | undefined;
  /** A reasoning level such as "low" or "high", matched to the model's own control. */
  readonly effort: string | undefined;
  readonly plan: boolean;
}

/**
 * The router's proposals. Each is a paused scheduled task, so T3 already stores it, shows it and runs
 * it on demand; the user accepts one by running it, and discards one by deleting it. What T3 cannot
 * hold, the channel conversation a proposal came from, is kept here, and given to the worker as tags
 * when it starts.
 */
export class Proposals extends Context.Service<
  Proposals,
  {
    readonly propose: (
      input: ProposeInput,
    ) => Effect.Effect<{ readonly id: ScheduledTaskId }, ProposalError>;
  }
>()("t3/router/Proposals") {}

const OriginRow = Schema.Struct({ origin: Schema.String, from_user: Schema.Number });
const decodeOriginRows = Schema.decodeUnknownEffect(Schema.Array(OriginRow));

export const layer = Layer.effect(
  Proposals,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const scheduled = yield* ScheduledTaskService;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const channels = yield* Channels.Channels;
    const providerRegistry = yield* ProviderRegistry;
    const failed = (message: string) => () => new ProposalError({ message });

    // super-t3's own table; upstream migrations never see it.
    yield* sql`CREATE TABLE IF NOT EXISTS super_t3_proposal_origins (
      task_id TEXT PRIMARY KEY,
      origin TEXT NOT NULL,
      from_user INTEGER NOT NULL
    )`.pipe(Effect.orDie);
    // Discarded proposals leave their origin behind; drop the ones whose task is gone.
    const live = yield* scheduled.list().pipe(
      Effect.map((result) => result.tasks.filter(isProposalTask).map((task) => task.id)),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
    yield* sql`DELETE FROM super_t3_proposal_origins WHERE task_id NOT IN ${sql.in(live)}`.pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not tidy proposal origins", { cause })),
    );

    const originOf = (taskId: string) =>
      sql`SELECT origin, from_user FROM super_t3_proposal_origins WHERE task_id = ${taskId}`.pipe(
        Effect.flatMap(decodeOriginRows),
        Effect.map((rows) => rows[0] ?? null),
      );

    /** An accepted proposal's worker carries where it came from; the proposal itself is used up. */
    const onAccepted = Effect.fn("Proposals.onAccepted")(
      function* (taskId: ScheduledTaskId, threadId: ThreadId) {
        const row = yield* originOf(taskId);
        if (row !== null) {
          const tags = [row.origin, ...(row.from_user === 1 ? [FROM_USER_TAG] : [])];
          for (const tag of tags) {
            yield* threads.dispatch({
              type: "thread.tag.set",
              commandId: CommandId.make(`proposal:tag:${threadId}:${tag}`),
              threadId,
              tag: tag as ThreadTag,
              tagged: true,
            });
          }
          yield* sql`DELETE FROM super_t3_proposal_origins WHERE task_id = ${taskId}`;
        }
        yield* scheduled.delete({ id: taskId });
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not finish accepting a proposal", { cause }),
      ),
    );

    const onEvent = (event: OrchestrationV2DomainEvent) => {
      // A scheduled run's first message names its task; only proposals are used up by running.
      if (
        event.type !== "turn-item.updated" ||
        event.payload.type !== "user_message" ||
        event.payload.scheduledTaskId === undefined
      ) {
        return Effect.void;
      }
      const taskId = event.payload.scheduledTaskId;
      return scheduled.list().pipe(
        Effect.map((result) => result.tasks.find((task) => task.id === taskId)),
        Effect.flatMap((task) =>
          task !== undefined && isProposalTask(task)
            ? onAccepted(task.id, event.threadId)
            : Effect.void,
        ),
        Effect.ignoreCause,
      );
    };
    yield* Effect.forkScoped(
      Stream.runForEach(engine.streamDomainEvents, onEvent).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Proposal events stopped", { cause })),
      ),
    );

    return Proposals.of({
      propose: Effect.fn("Proposals.propose")(function* (input) {
        const router = yield* threads
          .getThreadProjection(input.routerId)
          .pipe(Effect.mapError(failed("Could not read the router thread.")));
        // Only a message the server wrote counts, so typed text cannot fake where it came from.
        const trigger = router.messages.findLast((message) => message.role === "user");
        const origin =
          trigger?.creationSource === "server" && trigger.text.startsWith("[slack ")
            ? slackOriginOf(trigger.text)
            : null;
        const fromUser = origin !== null && trigger !== undefined && isFromUser(trigger.text);
        const { task } = yield* scheduled
          .upsert({
            title: input.title,
            prompt: input.brief,
            enabled: false,
            schedule: { type: "once", runAt: PROPOSAL_RUN_AT },
            projectId: input.projectId,
            workspaceStrategy: input.workspaceStrategy,
            modelSelection: resolveModelOptions(
              input.modelSelection ?? router.thread.modelSelection,
              input.effort,
              yield* providerRegistry.getProviders,
            ),
            runtimeMode: "full-access",
            interactionMode: input.plan ? "plan" : "default",
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(Effect.mapError((error) => new ProposalError({ message: error.message })));
        if (origin !== null) {
          yield* sql`INSERT OR REPLACE INTO super_t3_proposal_origins (task_id, origin, from_user)
            VALUES (${task.id}, ${origin}, ${fromUser ? 1 : 0})`.pipe(
            Effect.mapError(failed("Could not remember where the proposal came from.")),
          );
          if (fromUser) {
            yield* channels
              .announce(origin, proposalNote(input.title))
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not announce a proposal", { cause }),
                ),
              );
          }
        }
        return { id: task.id };
      }),
    });
  }),
);
