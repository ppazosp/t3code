import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ChannelError, type ChannelAdapter } from "./Channel.ts";
import * as ChannelBridge from "./ChannelBridge.ts";
import { readSlackSettings } from "./slack/parse.ts";
import * as SlackAdapter from "./slack/SlackAdapter.ts";

export { ChannelError } from "./Channel.ts";

export interface ChannelsShape {
  /** Posts the router's reply where a channel message came from, named by the `ref` it carried. */
  readonly reply: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
  /** Posts super-t3's own note in a conversation, such as a proposal it made from the user's message. */
  readonly announce: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
}

/**
 * The channels outside T3: Slack so far, each an adapter behind one interface. The bridge passes
 * their messages to the router or to the task they answer, and reports approved tasks back where
 * they came from. Channels are configured by environment variables, so the settings schema stays
 * upstream's.
 */
export class Channels extends Context.Service<Channels, ChannelsShape>()("t3/channels/Channels") {}

const settingsConfig = Config.all({
  botToken: Config.String("T3_SLACK_BOT_TOKEN").pipe(Config.option),
  appToken: Config.String("T3_SLACK_APP_TOKEN").pipe(Config.option),
  trustedUserId: Config.String("T3_SLACK_TRUSTED_USER_ID").pipe(Config.option),
  watchedChannels: Config.String("T3_SLACK_WATCHED_CHANNELS").pipe(Config.option),
});

export const layer: Layer.Layer<
  Channels,
  never,
  | ThreadManagementService.ThreadManagementService
  | Orchestrator.OrchestratorV2
  | HttpClient.HttpClient
> = Layer.effect(
  Channels,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
    // The router answers only where the user wrote to it, so text it read from anyone else
    // cannot send it to post somewhere new.
    const userRefs = new Set<string>();
    const adapters: Array<ChannelAdapter> = [];
    const slack = readSlackSettings(
      yield* settingsConfig.pipe(
        Effect.orElseSucceed(() => ({
          botToken: Option.none<string>(),
          appToken: Option.none<string>(),
          trustedUserId: Option.none<string>(),
          watchedChannels: Option.none<string>(),
        })),
      ),
    );
    if (Option.isSome(slack)) adapters.push(yield* SlackAdapter.make(slack.value));
    if (adapters.length > 0) {
      yield* Effect.forkScoped(
        ChannelBridge.run({ adapters, threads, engine, userRefs }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("The channel bridge stopped", { cause })),
        ),
      );
    }
    const adapterFor = (ref: string) =>
      Effect.fromNullishOr(adapters.find((candidate) => ref.startsWith(candidate.prefix))).pipe(
        Effect.mapError(() => new ChannelError({ message: "No channel is connected to this T3." })),
      );
    return Channels.of({
      announce: Effect.fn("Channels.announce")(function* (ref, text) {
        const adapter = yield* adapterFor(ref);
        yield* adapter.post(ref, text);
      }),
      reply: Effect.fn("Channels.reply")(function* (ref, text) {
        const adapter = yield* adapterFor(ref);
        if (!userRefs.has(ref)) {
          return yield* new ChannelError({
            message: `You can reply only to a message the user sent you; ${ref} is not one.`,
          });
        }
        yield* adapter.post(ref, text);
      }),
    });
  }),
);
