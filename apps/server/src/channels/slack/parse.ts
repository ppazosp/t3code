import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ChannelAnswer, ChannelMessage } from "../Channel.ts";

/**
 * Slack, as the router sees it. Socket Mode delivers events over a WebSocket, so the server needs
 * no public URL; replies go through the Web API. Only the fields T3 reads are decoded.
 */
export interface SlackSettings {
  readonly botToken: string;
  readonly appToken: string;
  /** The Slack member whose DMs and mentions are requests from the user of this T3. */
  readonly trustedUserId: string;
  /** Channels whose messages the router reads to propose work, without a mention. */
  readonly watchedChannels: ReadonlySet<string>;
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
      const watched = settings.watchedChannels.has(message.channel);
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

export const APPROVE_ACTION = "super_t3_approve";
export const CHANGE_ACTION = "super_t3_change";
/** The form Change opens; sending it answers the plan. */
export const CHANGE_FORM = "super_t3_change_form";
const CHANGE_BLOCK = "change";
const CHANGE_INPUT = "text";

const ButtonClick = Schema.Struct({
  type: Schema.Literal("block_actions"),
  user: Schema.Struct({ id: Schema.String }),
  trigger_id: Schema.optional(Schema.String),
  container: Schema.Struct({ channel_id: Schema.String, message_ts: Schema.String }),
  actions: Schema.Tuple([
    Schema.Struct({
      action_id: Schema.Literals([APPROVE_ACTION, CHANGE_ACTION]),
      value: Schema.String,
    }),
  ]),
});

/** What the Change form carries back: the plan it answers and the message that asked. */
const FormContext = Schema.Struct({ askId: Schema.String, message: Schema.String });
const decodeFormContext = Schema.decodeUnknownOption(Schema.fromJsonString(FormContext));
const encodeFormContext = Schema.encodeSync(Schema.fromJsonString(FormContext));

const FormSent = Schema.Struct({
  type: Schema.Literal("view_submission"),
  user: Schema.Struct({ id: Schema.String }),
  view: Schema.Struct({
    callback_id: Schema.Literal(CHANGE_FORM),
    private_metadata: Schema.String,
    state: Schema.Struct({
      values: Schema.Struct({
        [CHANGE_BLOCK]: Schema.Struct({
          [CHANGE_INPUT]: Schema.Struct({ value: Schema.NullOr(Schema.String) }),
        }),
      }),
    }),
  }),
});

const decodeInteraction = Schema.decodeUnknownOption(Schema.Union([ButtonClick, FormSent]));

/**
 * A click on a plan's buttons, or the Change form sent. Approve answers the plan; Change only opens
 * the form (`openForm`), and the form, once sent, answers it.
 */
export function readSlackInteraction(
  payload: unknown,
  trustedUserId: string,
):
  | { readonly type: "answer"; readonly answer: ChannelAnswer }
  | { readonly type: "openForm"; readonly triggerId: string; readonly context: string }
  | null {
  const interaction = decodeInteraction(payload);
  if (Option.isNone(interaction)) return null;
  const value = interaction.value;
  const fromUser = value.user.id === trustedUserId;
  if (value.type === "block_actions") {
    const [action] = value.actions;
    const message = `slack:${value.container.channel_id}:${value.container.message_ts}`;
    if (action.action_id === CHANGE_ACTION) {
      if (value.trigger_id === undefined) return null;
      return {
        type: "openForm",
        triggerId: value.trigger_id,
        context: encodeFormContext({ askId: action.value, message }),
      };
    }
    return {
      type: "answer",
      answer: { askId: action.value, message, fromUser, decision: "approve", text: "" },
    };
  }
  const context = decodeFormContext(value.view.private_metadata);
  if (Option.isNone(context)) return null;
  return {
    type: "answer",
    answer: {
      ...context.value,
      fromUser,
      decision: "change",
      text: (value.view.state.values[CHANGE_BLOCK][CHANGE_INPUT].value ?? "").trim(),
    },
  };
}

/** The form that asks what to change. `context` names the plan and the message that asked. */
export const changeForm = (context: string) => ({
  type: "modal",
  callback_id: CHANGE_FORM,
  private_metadata: context,
  title: { type: "plain_text", text: "Ask for changes" },
  submit: { type: "plain_text", text: "Send" },
  close: { type: "plain_text", text: "Cancel" },
  blocks: [
    {
      type: "input",
      block_id: CHANGE_BLOCK,
      label: { type: "plain_text", text: "What should change?" },
      element: { type: "plain_text_input", action_id: CHANGE_INPUT, multiline: true },
    },
  ],
});

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
 * A plan as Markdown that cannot ping anyone or hide a link. Escaped `<`, `>` and `&` show as
 * text, and a backslash before every `[` stops inline and reference links, so only bare addresses
 * link, and they show themselves (measured in Slack for atta).
 */
export const slackMarkdown = (text: string) =>
  // Backslashes first, so a model's own `\\[` cannot cancel the escape.
  escapeSlackText(text).replaceAll("\\", "\\\\").replaceAll("[", "\\[");

export const slackMarkdownFits = (text: string) => slackMarkdown(text).length <= MARKDOWN_LIMIT;

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
      watchedChannels: new Set(
        Option.getOrElse(env.watchedChannels, () => "")
          .split(",")
          .map((channel) => channel.trim())
          .filter((channel) => channel !== ""),
      ),
      apiUrl: Option.getOrElse(env.apiUrl, () => SLACK_API_URL).replace(/\/+$/u, ""),
    })),
  );
}
