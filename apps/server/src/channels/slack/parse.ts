import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ChannelMessage } from "../Channel.ts";

/**
 * Slack, as the router sees it. Socket Mode delivers events over a WebSocket, so the server needs
 * no public URL; replies go through the Web API. Only the fields T3 reads are decoded.
 */
export interface SlackSettings {
  readonly botToken: string;
  readonly appToken: string;
  /** The Slack member whose DMs and mentions are requests from the user of this T3. */
  readonly trustedUserId: string;
  /**
   * Channels whose messages the router reads to propose work, without a mention: these, or `all`,
   * every channel the bot is in.
   */
  readonly watchedChannels: ReadonlySet<string> | "all";
  /** Slack's Web API, or a stand-in for it in tests. */
  readonly apiUrl: string;
}

const SLACK_API_URL = "https://slack.com/api";

export const SocketEnvelope = Schema.Struct({
  type: Schema.String,
  envelope_id: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});

const SlackMessageEvent = Schema.Struct({
  type: Schema.Literals(["message", "app_mention"]),
  channel: Schema.String,
  channel_type: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
});

const EventsApiPayload = Schema.Struct({
  team_id: Schema.optional(Schema.String),
  event: Schema.Unknown,
});

const decodePayload = Schema.decodeUnknownOption(EventsApiPayload);
const decodeEvent = Schema.decodeUnknownOption(SlackMessageEvent);

/**
 * Turns an Events API payload into a message for the router, or nothing. The router reads DMs and
 * mentions from the user, and everything said in a watched channel. A mention in a watched channel
 * arrives twice, as `message` and `app_mention`; both carry the same id, so the second is a
 * duplicate the caller drops.
 */
export function readSlackMessage(
  payload: unknown,
  settings: Pick<SlackSettings, "trustedUserId" | "watchedChannels">,
  botUserId: string,
): Option.Option<ChannelMessage> {
  return Option.flatMap(decodePayload(payload), ({ event }) =>
    Option.flatMap(decodeEvent(event), (message) => {
      if (
        message.bot_id !== undefined ||
        message.user === undefined ||
        message.user === botUserId ||
        (message.subtype !== undefined && message.subtype !== "thread_broadcast")
      ) {
        return Option.none();
      }
      const text = (message.text ?? "").trim();
      const fromUser = message.user === settings.trustedUserId;
      const isDm = message.channel_type === "im";
      const mentionsBot = message.type === "app_mention" || text.includes(`<@${botUserId}>`);
      const watched =
        settings.watchedChannels === "all" || settings.watchedChannels.has(message.channel);
      const relevant = isDm ? fromUser : watched || (mentionsBot && fromUser);
      if (!relevant || text === "") return Option.none();
      return Option.some({
        id: `slack:${message.channel}:${message.ts}`,
        ref: `slack:${message.channel}:${message.thread_ts ?? message.ts}`,
        fromUser,
        direct: isDm || mentionsBot,
        where: isDm ? "dm" : `#${message.channel}`,
        author: fromUser ? "you" : `@${message.user}`,
        text: text.replaceAll(`<@${botUserId}>`, "").trim(),
      });
    }),
  );
}

/**
 * Someone other than the user writing to T3 in a DM, such as a teammate opening its agent panel.
 * Returns the conversation, so T3 can say once that it works only for the user.
 */
export function readSlackOutsider(
  payload: unknown,
  settings: Pick<SlackSettings, "trustedUserId">,
  botUserId: string,
): string | null {
  const event = Option.flatMap(decodePayload(payload), ({ event }) => decodeEvent(event));
  if (Option.isNone(event)) return null;
  const message = event.value;
  if (
    message.channel_type !== "im" ||
    message.bot_id !== undefined ||
    message.subtype !== undefined ||
    message.user === undefined ||
    message.user === botUserId ||
    message.user === settings.trustedUserId
  ) {
    return null;
  }
  return `slack:${message.channel}:${message.thread_ts ?? message.ts}`;
}

// Slack documents this event without a sample payload, so both spellings of its fields are read.
const AgentSessionStopped = Schema.Struct({
  type: Schema.Literal("agent_session_stopped"),
  channel: Schema.optional(Schema.String),
  channel_id: Schema.optional(Schema.String),
  thread_ts: Schema.String,
  user: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
});
const decodeStopped = Schema.decodeUnknownOption(AgentSessionStopped);

/** The Stop button of Slack's agent panel, pressed while T3 worked on that conversation. */
export function readSlackStop(
  payload: unknown,
  trustedUserId: string,
): { readonly ref: string; readonly fromUser: boolean } | null {
  const stopped = Option.flatMap(decodePayload(payload), ({ event }) => decodeStopped(event));
  if (Option.isNone(stopped)) return null;
  const channel = stopped.value.channel ?? stopped.value.channel_id;
  if (channel === undefined) return null;
  return {
    ref: `slack:${channel}:${stopped.value.thread_ts}`,
    fromUser: (stopped.value.user ?? stopped.value.user_id) === trustedUserId,
  };
}

export function parseSlackRef(
  ref: string,
): Option.Option<{ readonly channel: string; readonly threadTs: string }> {
  const match = /^slack:([A-Z0-9]+):(\d+\.\d+)$/u.exec(ref);
  return match === null ? Option.none() : Option.some({ channel: match[1]!, threadTs: match[2]! });
}

/** Slack's control characters as text, so a reply cannot ping a channel or hide a link. */
export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Slack refuses a Markdown block over 12,000 characters (measured for atta on 4 November 2026).
const MARKDOWN_LIMIT = 12_000;

/**
 * Markdown that cannot ping anyone or hide a link. Escaped `<`, `>` and `&` show as text, and a
 * backslash before every `[` stops inline and reference links, so only bare addresses link, and
 * they show themselves (measured in Slack for atta). A Markdown link first becomes its label: a
 * local file's path means nothing to the reader, and a web address is kept in brackets after it.
 */
export const slackMarkdown = (text: string) =>
  // Backslashes first, so a model's own `\\[` cannot cancel the escape.
  escapeSlackText(plainLinks(text)).replaceAll("\\", "\\\\").replaceAll("[", "\\[");

/** Markdown links as their label, or label and address for a web link, so none hides where it goes. */
export const plainLinks = (text: string) =>
  text.replaceAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (_, label: string, target: string) =>
    /^https?:\/\//iu.test(target) ? `${label} (${target})` : label,
  );

export const slackMarkdownFits = (text: string) => slackMarkdown(text).length <= MARKDOWN_LIMIT;

function watchedChannelsOf(value: string): ReadonlySet<string> | "all" {
  if (value.trim().toLowerCase() === "all") return "all";
  return new Set(
    value
      .split(",")
      .map((channel) => channel.trim())
      .filter((channel) => channel !== ""),
  );
}

export function readSlackSettings(env: {
  readonly botToken: Option.Option<string>;
  readonly appToken: Option.Option<string>;
  readonly trustedUserId: Option.Option<string>;
  readonly watchedChannels: Option.Option<string>;
  readonly apiUrl: Option.Option<string>;
}): Option.Option<SlackSettings> {
  return Option.all({
    botToken: env.botToken,
    appToken: env.appToken,
    trustedUserId: env.trustedUserId,
  }).pipe(
    Option.map((required) => ({
      ...required,
      watchedChannels: watchedChannelsOf(Option.getOrElse(env.watchedChannels, () => "")),
      apiUrl: Option.getOrElse(env.apiUrl, () => SLACK_API_URL).replace(/\/+$/u, ""),
    })),
  );
}
