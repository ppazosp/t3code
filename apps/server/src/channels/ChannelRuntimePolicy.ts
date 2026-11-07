import { ACCEPTED_TAG_PREFIX } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { workerInstructions } from "./instructions.ts";
import { CHANNELS, type RegisteredChannel } from "./registry.ts";

const decodeOrigins = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ origin: Schema.String })),
);

const channelOf = (ref: string, channels: ReadonlyArray<RegisteredChannel>) =>
  channels.find((channel) => ref.startsWith(`${channel.name}:`));

/**
 * Gives a worker whose task came from a channel conversation the system prompt block for working
 * there, and the channel's own. Its first turn starts before the proposal is turned into an origin
 * tag, so a thread marked accepted reads the origin from the proposal.
 */
export const layer: Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2 | SqlClient.SqlClient> =
  Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      const sql = yield* SqlClient.SqlClient;
      const proposalOrigin = (taskId: string) =>
        sql`SELECT origin FROM super_t3_proposal_origins WHERE task_id = ${taskId}`.pipe(
          Effect.flatMap(decodeOrigins),
          Effect.map((rows) => rows[0]?.origin),
          // The table appears with the first proposal.
          Effect.orElseSucceed(() => undefined),
        );
      return RuntimePolicyV2.of({
        resolve: Effect.fn("ChannelRuntimePolicy.resolve")(function* (input) {
          const policy = yield* base.resolve(input);
          const tags = input.thread.tags ?? [];
          let origin = tags.find((tag) => channelOf(tag, CHANNELS) !== undefined);
          const accepted = tags.find((tag) => tag.startsWith(ACCEPTED_TAG_PREFIX));
          if (origin === undefined && accepted !== undefined) {
            origin = yield* proposalOrigin(accepted.slice(ACCEPTED_TAG_PREFIX.length));
          }
          const channel = origin === undefined ? undefined : channelOf(origin, CHANNELS);
          if (channel === undefined) return policy;
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            instructions: workerInstructions(channel.name, channel.instructions),
          });
        }),
      });
    }),
  );
