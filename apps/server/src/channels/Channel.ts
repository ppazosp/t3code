import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

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
  readonly where: string;
  readonly author: string;
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

/** One outside channel, such as Slack: messages in, posts and progress out. */
export interface ChannelAdapter {
  /** The prefix of every ref this channel issues, such as `slack:`. */
  readonly prefix: string;
  readonly messages: Stream.Stream<ChannelMessage>;
  /** Posts plain text in the conversation `ref` names. Markup in it shows as typed. */
  readonly post: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
  /**
   * Posts a progress message in the conversation `ref` names, or edits `message`, the ref an earlier
   * call returned. The adapter spaces out edits, so callers can send every change.
   */
  readonly showProgress: (input: {
    readonly ref: string;
    readonly message: string | null;
    readonly progress: Progress;
  }) => Effect.Effect<string, ChannelError>;
}
