import { ACCEPTED_TAG_PREFIX, WORKER_TAG } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { workerInstructions as channelInstructions } from "../channels/instructions.ts";
import { CHANNELS, type RegisteredChannel } from "../channels/registry.ts";
import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { SuperT3Home } from "./SuperT3Home.ts";

const decodeOrigins = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ origin: Schema.String })),
);

const channelOf = (ref: string, channels: ReadonlyArray<RegisteredChannel>) =>
  channels.find((channel) => ref.startsWith(`${channel.name}:`));

/**
 * Gives every worker the router proposed worker.md as part of its system prompt, read on every turn,
 * and a worker from a channel conversation the block for working there plus the channel's own. Its
 * first turn starts before the proposal is turned into tags, so a thread marked accepted reads its
 * origin from the proposal.
 */
export const layer: Layer.Layer<
  RuntimePolicyV2,
  never,
  RuntimePolicyV2 | SqlClient.SqlClient | SuperT3Home
> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    const sql = yield* SqlClient.SqlClient;
    const home = yield* SuperT3Home;
    const proposalOrigin = (taskId: string) =>
      sql`SELECT origin FROM super_t3_proposal_origins WHERE task_id = ${taskId}`.pipe(
        Effect.flatMap(decodeOrigins),
        Effect.map((rows) => rows[0]?.origin),
        // The table appears with the first proposal.
        Effect.orElseSucceed(() => undefined),
      );
    return RuntimePolicyV2.of({
      resolve: Effect.fn("WorkerRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        const tags = input.thread.tags ?? [];
        const accepted = tags.find((tag) => tag.startsWith(ACCEPTED_TAG_PREFIX));
        let origin = tags.find((tag) => channelOf(tag, CHANNELS) !== undefined);
        if (origin === undefined && accepted !== undefined) {
          origin = yield* proposalOrigin(accepted.slice(ACCEPTED_TAG_PREFIX.length));
        }
        const isWorker =
          accepted !== undefined || tags.includes(WORKER_TAG) || origin !== undefined;
        if (!isWorker) return policy;
        const channel = origin === undefined ? undefined : channelOf(origin, CHANNELS);
        const blocks = [
          yield* home.workerInstructions,
          channel === undefined
            ? undefined
            : channelInstructions(channel.name, channel.instructions),
        ].filter((block) => block !== undefined);
        if (blocks.length === 0) return policy;
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          instructions: blocks.join("\n\n"),
        });
      }),
    });
  }),
);
