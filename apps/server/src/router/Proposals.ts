import {
  ACCEPTED_TAG_PREFIX,
  channelSourceLabels,
  CommandId,
  FROM_USER_TAG,
  isProposalTask,
  PROPOSAL_RUN_AT,
  readChannelHeader,
  withProposalSource,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ProposalSource,
  type ScheduledTask,
  type ScheduledTaskId,
  type ServerProvider,
  type ThreadId,
  type ThreadTag,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Channels from "../channels/Channels.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";

export class ProposalError extends Schema.TaggedError<ProposalError>()("ProposalError", {
  message: Schema.String,
}) {}

/**
 * Where a channel message came from, read from the header the channel bridge wrote and the quoted
 * lines under it, for the proposal's card.
 */
export function sourceOf(text: string, at: string): ProposalSource | null {
  const header = readChannelHeader(text);
  if (header === null) return null;
  return {
    kind: header.channel,
    ...channelSourceLabels(header),
    // Long messages are cut; the card shows the gist, and the brief carries the work.
    text: header.body.length <= 600 ? header.body : `${header.body.slice(0, 600)}…`,
    at,
  };
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

/** Who a worker can be, with the model and effort it runs on unless the router asks for another. */
const WORKER_AGENTS = {
  codex: { driver: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
  claude: { driver: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
} as const;
export type WorkerAgent = keyof typeof WORKER_AGENTS;

/** A worker's model: its agent's default, on that provider's instance in this T3, if it has one. */
export function workerModelSelection(
  agent: WorkerAgent,
  effort: string | undefined,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  const defaults = WORKER_AGENTS[agent];
  const instance =
    providers.find((provider) => provider.instanceId === defaults.driver) ??
    providers.find((provider) => provider.driver === defaults.driver);
  if (instance === undefined) return null;
  return resolveModelOptions(
    { instanceId: instance.instanceId, model: defaults.model, options: [] },
    effort ?? defaults.effort,
    providers,
  );
}

export interface ProposeInput {
  readonly routerId: ThreadId;
  readonly title: string;
  readonly brief: string;
  readonly projectId: ProjectId;
  readonly workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy;
  /** Who does the work, on its default model. */
  readonly agent: WorkerAgent;
  /** A reasoning level such as "low" or "high" in place of the agent's default. */
  readonly effort: string | undefined;
  readonly plan: boolean;
}

/**
 * The router's proposals. Each is a paused scheduled task, so T3 already stores and syncs it; the
 * user opens one as a draft, accepts it by sending that draft, and discards it by deleting it. What T3
 * cannot hold, the channel conversation a proposal came from, is kept here, and given to the worker
 * as tags when it starts.
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

    /**
     * The client tags the thread a proposal's draft became. Its worker then carries the proposal's
     * title and where it came from, the proposal is used up, and the marker tag goes.
     */
    const onAccepted = Effect.fn("Proposals.onAccepted")(
      function* (task: ScheduledTask, threadId: ThreadId, marker: string) {
        const row = yield* originOf(task.id);
        const tags =
          row === null ? [] : [row.origin, ...(row.from_user === 1 ? [FROM_USER_TAG] : [])];
        // The title first: the worker posts in its conversation as soon as it is tagged.
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`proposal:title:${threadId}`),
          threadId,
          title: task.title,
        });
        for (const tag of tags) {
          yield* threads.dispatch({
            type: "thread.tag.set",
            commandId: CommandId.make(`proposal:tag:${threadId}:${tag}`),
            threadId,
            tag: tag as ThreadTag,
            tagged: true,
          });
        }
        yield* sql`DELETE FROM super_t3_proposal_origins WHERE task_id = ${task.id}`;
        yield* scheduled.delete({ id: task.id });
        yield* threads.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`proposal:untag:${threadId}:${marker}`),
          threadId,
          tag: marker as ThreadTag,
          tagged: false,
        });
      },
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not finish accepting a proposal", { cause }),
      ),
    );

    const onEvent = (event: OrchestrationV2DomainEvent) => {
      if (event.type !== "thread.tags-updated") return Effect.void;
      const marker = event.payload.tags?.find((tag) => tag.startsWith(ACCEPTED_TAG_PREFIX));
      if (marker === undefined) return Effect.void;
      const taskId = marker.slice(ACCEPTED_TAG_PREFIX.length);
      return scheduled.list().pipe(
        Effect.map((result) => result.tasks.find((task) => task.id === taskId)),
        Effect.flatMap((task) =>
          // Only a live proposal is used up; a stale marker is just dropped.
          task !== undefined && isProposalTask(task)
            ? onAccepted(task, event.payload.id, marker)
            : threads.dispatch({
                type: "thread.tag.set",
                commandId: CommandId.make(`proposal:untag:${event.payload.id}:${marker}`),
                threadId: event.payload.id,
                tag: marker as ThreadTag,
                tagged: false,
              }),
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
        const header =
          trigger?.creationSource === "server" ? readChannelHeader(trigger.text) : null;
        const origin = header?.ref ?? null;
        const fromUser = header?.fromUser === true;
        const source =
          header === null || trigger === undefined
            ? null
            : sourceOf(trigger.text, DateTime.formatIso(trigger.createdAt));
        const modelSelection = workerModelSelection(
          input.agent,
          input.effort,
          yield* providerRegistry.getProviders,
        );
        if (modelSelection === null) {
          return yield* new ProposalError({
            message: `${input.agent === "codex" ? "Codex" : "Claude"} is not set up in this T3; propose the other agent.`,
          });
        }
        const { task } = yield* scheduled
          .upsert({
            title: input.title,
            prompt: source === null ? input.brief : withProposalSource(input.brief, source),
            enabled: false,
            schedule: { type: "once", runAt: PROPOSAL_RUN_AT },
            projectId: input.projectId,
            workspaceStrategy: input.workspaceStrategy,
            modelSelection,
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
              .proposed(origin)
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not mark a proposed message handled", { cause }),
                ),
              );
          }
        }
        return { id: task.id };
      }),
    });
  }),
);
