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

/** The answer to a plan T3 asked the user to approve in a channel. */
export interface ChannelAnswer {
  readonly askId: string;
  /** The message that asked, as `askApproval` returned it, to show the outcome in. */
  readonly message: string;
  readonly fromUser: boolean;
  readonly decision: "approve" | "change";
  /** What to change; empty for an approval. */
  readonly text: string;
}

export type ChannelEvent =
  | ({ readonly type: "message" } & ChannelMessage)
  | ({ readonly type: "answer" } & ChannelAnswer);

/** One message read back from a conversation, oldest first. */
export interface ChannelHistoryEntry {
  readonly author: string;
  readonly fromUser: boolean;
  readonly text: string;
}

export interface ProgressStep {
  readonly id: string;
  readonly text: string;
  readonly status: "pending" | "running" | "completed";
}

/** What a task is doing, as a channel shows it in one message it keeps editing. */
export interface Progress {
  readonly title: string;
  readonly steps: ReadonlyArray<ProgressStep>;
  /** Set once the run ends: how it ended, and the task's last message. */
  readonly finished: {
    readonly outcome: "completed" | "failed" | "interrupted";
    readonly result: string | null;
  } | null;
}

/**
 * One outside channel, such as Slack: messages in; posts, reactions, progress and approvals out.
 * Everything the user sees in a channel goes through these operations, so a new channel is one
 * adapter and one entry in `registry.ts`.
 */
export interface ChannelAdapter {
  /** The channel's name in messages to the router, such as `slack`. */
  readonly name: string;
  /** The prefix of every ref this channel issues: the name and a colon. */
  readonly prefix: string;
  readonly events: Stream.Stream<ChannelEvent>;
  /** Posts plain text in the conversation `ref` names. Markup in it shows as typed. */
  readonly post: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
  /**
   * Shows that T3 has a message (`seen`), then that it is handled (`done`): the router answered,
   * or a task took it. Slack shows these as 👀 and ✅ reactions.
   */
  readonly mark: (messageId: string, mark: "seen" | "done") => Effect.Effect<void, ChannelError>;
  /** The latest messages of the conversation `ref` names, oldest first: at most `limit`. */
  readonly read: (
    ref: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ChannelHistoryEntry>, ChannelError>;
  /**
   * Posts a progress message in the conversation `ref` names, or edits `message`, the ref an earlier
   * call returned. The adapter spaces out edits, so callers can send every change.
   */
  readonly showProgress: (input: {
    readonly ref: string;
    readonly message: string | null;
    readonly progress: Progress;
  }) => Effect.Effect<string, ChannelError>;
  /**
   * Posts a plan in the conversation `ref` names, in full, with Approve and Change buttons. A click
   * arrives as an `answer` event for `askId`. Returns the message. A plan too long for one message
   * is refused, never cut: the user approves only what they could read.
   */
  readonly askApproval: (input: {
    readonly ref: string;
    readonly askId: string;
    readonly title: string;
    readonly text: string;
  }) => Effect.Effect<string, ChannelError>;
  /** Whether a plan fits one message of this channel once it is made safe to post. */
  readonly fits: (text: string) => boolean;
  /** Shows the outcome in place of the buttons, so an answered plan cannot be answered again. */
  readonly closeApproval: (input: {
    readonly message: string;
    readonly title: string;
    readonly text: string;
    readonly outcome: string;
  }) => Effect.Effect<void, ChannelError>;
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
