import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Slack, as the router sees it. Socket Mode delivers events over a WebSocket, so the server needs
 * no public URL; replies go through the Web API. Only the fields atta reads are decoded.
 */
export interface SlackSettings {
  readonly botToken: string;
  readonly appToken: string;
  /** The Slack member whose DMs and mentions are requests from the user of this T3. */
  readonly trustedUserId: string;
  /** Channels whose messages the router reads to propose work, without a mention. */
  readonly watchedChannels: ReadonlySet<string>;
}

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

/** One message the router should read. `ref` is where a reply goes: the channel and thread. */
export interface ChannelMessage {
  readonly id: string;
  readonly ref: string;
  readonly fromUser: boolean;
  readonly where: string;
  readonly author: string;
  readonly text: string;
}

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
      const watched = settings.watchedChannels.has(message.channel);
      const relevant = isDm ? fromUser : watched || (mentionsBot && fromUser);
      if (!relevant || text === "") return Option.none();
      return Option.some({
        id: `slack:${message.channel}:${message.ts}`,
        ref: `slack:${message.channel}:${message.thread_ts ?? message.ts}`,
        fromUser,
        where: isDm ? "dm" : `#${message.channel}`,
        author: fromUser ? "you" : `@${message.user}`,
        text: text.replaceAll(`<@${botUserId}>`, "").trim(),
      });
    }),
  );
}

/** The router's message: a header it is told how to read, then the text exactly as written. */
export function routerMessageText(message: ChannelMessage): string {
  return `[slack ${message.where} from ${message.author} ref=${message.ref}]\n${message.text}`;
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

export function readSlackSettings(env: {
  readonly botToken: Option.Option<string>;
  readonly appToken: Option.Option<string>;
  readonly trustedUserId: Option.Option<string>;
  readonly watchedChannels: Option.Option<string>;
}): Option.Option<SlackSettings> {
  return Option.all({
    botToken: env.botToken,
    appToken: env.appToken,
    trustedUserId: env.trustedUserId,
  }).pipe(
    Option.map((required) => ({
      ...required,
      watchedChannels: new Set(
        Option.getOrElse(env.watchedChannels, () => "")
          .split(",")
          .map((channel) => channel.trim())
          .filter((channel) => channel !== ""),
      ),
    })),
  );
}
