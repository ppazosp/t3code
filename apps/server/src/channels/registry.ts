import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import type { HttpClient } from "effect/http";

import type { ChannelAdapter, ChannelDefinition } from "./Channel.ts";
import { slackChannel } from "./slack/SlackChannel.ts";

/** A channel T3 knows, with its settings already read: connecting gives its adapter, if it is on. */
export interface RegisteredChannel {
  readonly name: string;
  readonly instructions?: string | undefined;
  readonly connect: Effect.Effect<
    Option.Option<ChannelAdapter>,
    never,
    HttpClient.HttpClient | Scope.Scope
  >;
}

const register = <Settings>(definition: ChannelDefinition<Settings>): RegisteredChannel => ({
  name: definition.name,
  instructions: definition.instructions,
  connect: Effect.gen(function* () {
    const settings: Option.Option<Settings> = yield* definition.settings.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`Could not read the ${definition.name} settings`, { cause }).pipe(
          Effect.as(Option.none<Settings>()),
        ),
      ),
    );
    if (Option.isNone(settings)) return Option.none<ChannelAdapter>();
    return yield* definition.make(settings.value).pipe(
      Effect.asSome,
      Effect.catchCause((cause) =>
        Effect.logWarning(`Could not connect ${definition.name}`, { cause }).pipe(
          Effect.as(Option.none<ChannelAdapter>()),
        ),
      ),
    );
  }),
});

/** Every channel T3 can connect to. A new channel is one adapter and one line here. */
export const CHANNELS: ReadonlyArray<RegisteredChannel> = [register(slackChannel)];
