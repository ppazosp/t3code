import type * as Config from "effect/Config";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";
import type { HttpClient } from "effect/http";

export class ChannelError extends Schema.TaggedError<ChannelError>()("ChannelError", {
  message: Schema.String,
}) {}

/**
 * One message from outside T3. `ref` names the conversation it belongs to, such as a Slack thread,
 * and every channel prefixes its refs with its own name, so `ref` also says which channel to answer
 * through.
 */
export interface ChannelMessage {
  readonly id: string;
  readonly ref: string;
  /** Whether the user of this T3 wrote it. Anyone else's message is information, never a request. */
  readonly fromUser: boolean;
  /**
   * Written to T3 itself: a DM, or a mention in a channel. Only the user's direct messages are
   * requests; anything else said where T3 listens is information for the router.
   */
  readonly direct: boolean;
  readonly where: string;
  readonly author: string;
  readonly text: string;
}

export type ChannelEvent =
  | ({ readonly type: "message" } & ChannelMessage)
  /** The channel's own Stop control, pressed in the conversation `ref` names. */
  | { readonly type: "stop"; readonly ref: string; readonly fromUser: boolean }
  /** Someone other than the user wrote to T3 directly, where T3 should say it works only for the user. */
  | { readonly type: "outsider"; readonly ref: string };

/** One message read back from a conversation, oldest first. */
export interface ChannelHistoryEntry {
  readonly id: string;
  readonly author: string;
  readonly fromUser: boolean;
  /** Written by a bot, T3 included. */
  readonly bot: boolean;
  readonly text: string;
}

/** What T3 posts: Markdown, which the adapter makes safe to post. */
export interface ChannelPost {
  readonly text: string;
}

/**
 * One outside channel, such as Slack: messages in; posts, reactions and status out. Everything the
 * user sees in a channel goes through these operations, so a new channel is one adapter and one
 * entry in `registry.ts`.
 */
export interface ChannelAdapter {
  /** The channel's name in messages to the router, such as `slack`. */
  readonly name: string;
  /** The prefix of every ref this channel issues: the name and a colon. */
  readonly prefix: string;
  readonly events: Stream.Stream<ChannelEvent>;
  /**
   * Posts in the conversation `ref` names. Markdown renders, but cannot ping anyone or hide a link.
   * Returns the posted message's id.
   */
  readonly post: (ref: string, post: ChannelPost) => Effect.Effect<string, ChannelError>;
  /**
   * Shows that T3 has a message (`seen`), then that it is handled (`done`): the router answered,
   * or a task took it. Slack shows these as 👀 and ✅ reactions.
   */
  readonly mark: (messageId: string, mark: "seen" | "done") => Effect.Effect<void, ChannelError>;
  /**
   * Shows whether T3 is working on the conversation `ref` names, is done, or waits for the user,
   * where the channel shows such a status. Slack shows it in its agent panel, with a Stop button
   * while T3 works; elsewhere it does nothing.
   */
  readonly status: (
    ref: string,
    status: "working" | "idle" | "waiting",
  ) => Effect.Effect<void, ChannelError>;
  /** The latest messages of the conversation `ref` names, oldest first: at most `limit`. */
  readonly read: (
    ref: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ChannelHistoryEntry>, ChannelError>;
}

/**
 * A kind of channel T3 can connect to. Its settings come from the environment; with none set, the
 * channel stays off.
 */
export interface ChannelDefinition<Settings> {
  readonly name: string;
  readonly settings: Config.Config<Option.Option<Settings>>;
  readonly make: (
    settings: Settings,
  ) => Effect.Effect<ChannelAdapter, ChannelError, HttpClient.HttpClient | Scope.Scope>;
}
