import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  ChannelError,
  type ChannelAdapter,
  type ChannelEvent,
  type ChannelFile,
  type ChannelHistoryEntry,
} from "../Channel.ts";
import { slackBlocks } from "./blocks.ts";
import {
  escapeSlackText,
  parseSlackRef,
  plainLinks,
  readSlackMessage,
  readSlackOutsider,
  readSlackStop,
  slackMarkdownFits,
  SocketEnvelope,
  headerSafe,
  type SlackSelf,
  type SlackSettings,
} from "./parse.ts";

const SlackOk = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });
const ConnectionsOpen = Schema.Struct({ url: Schema.String });
const AuthTest = Schema.Struct({ user_id: Schema.String, bot_id: Schema.optional(Schema.String) });
const Posted = Schema.Struct({ channel: Schema.String, ts: Schema.String });
const UploadSlot = Schema.Struct({ upload_url: Schema.String, file_id: Schema.String });
const encodeUploaded = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String }))),
);

/** Slack takes files up to 1 GB. */
const SLACK_FILE_LIMIT = 1024 * 1024 * 1024;
const Replies = Schema.Struct({
  messages: Schema.Array(
    Schema.Struct({
      ts: Schema.String,
      user: Schema.optional(Schema.String),
      bot_id: Schema.optional(Schema.String),
      text: Schema.optional(Schema.String),
    }),
  ),
  response_metadata: Schema.optional(
    Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
  ),
});
const ConversationInfo = Schema.Struct({
  channel: Schema.Struct({ name: Schema.optional(Schema.String) }),
});
const UserInfo = Schema.Struct({
  user: Schema.Struct({
    name: Schema.optional(Schema.String),
    real_name: Schema.optional(Schema.String),
    profile: Schema.optional(
      Schema.Struct({
        display_name: Schema.optional(Schema.String),
        real_name: Schema.optional(Schema.String),
      }),
    ),
  }),
});

const SEEN_LIMIT = 500;

/** Remembers the last few hundred keys, oldest out first. */
function rememberBounded(keys: Set<string>, key: string) {
  keys.add(key);
  if (keys.size > SEEN_LIMIT) keys.delete(keys.values().next().value!);
}

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(SocketEnvelope));
const encodeAck = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ envelope_id: Schema.String })),
);

const slackCall = Effect.fn("SlackAdapter.call")(function* <A>(
  apiUrl: string,
  method: string,
  token: string,
  body: Record<string, unknown> | undefined,
  schema: Schema.Decoder<A>,
  /** Some methods, such as the file upload ones, take only form fields, not JSON. */
  form = false,
) {
  const client = yield* HttpClient.HttpClient;
  const unknownReply = () => new ChannelError({ message: `Slack ${method} sent an unknown reply` });
  const request = HttpClientRequest.post(`${apiUrl}/${method}`).pipe(
    HttpClientRequest.setHeaders({ Authorization: `Bearer ${token}` }),
    body === undefined
      ? (same) => same
      : form
        ? HttpClientRequest.bodyUrlParams(body as Record<string, string>)
        : HttpClientRequest.bodyJsonUnsafe(body),
  );
  const response = yield* client.execute(request).pipe(
    Effect.timeout("20 seconds"),
    Effect.mapError(() => new ChannelError({ message: `Slack ${method} could not be reached` })),
  );
  const status = yield* HttpClientResponse.schemaBodyJson(SlackOk)(response).pipe(
    Effect.mapError(unknownReply),
  );
  if (!status.ok) return yield* new ChannelError({ message: `Slack ${method}: ${status.error}` });
  return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
    Effect.mapError(unknownReply),
  );
});

/** Slack ignores a repeated reaction or a missing one; T3 does too. */
const ignoreReactionState = <A, R>(effect: Effect.Effect<A, ChannelError, R>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catchIf(
      (error: ChannelError) =>
        error.message.endsWith("already_reacted") || error.message.endsWith("no_reaction"),
      () => Effect.void,
    ),
  );

/** Slack's names for a session's status: "processing" shows its loading line and Stop button. */
const SESSION_STATUS = { working: "processing", idle: "active", waiting: "suspended" } as const;

const CUT_NOTE = "\n\n…The rest is in T3.";

/** Markdown cut to fit one Slack message, saying so; Slack refuses a longer block outright. */
function fitted(text: string): string {
  if (slackMarkdownFits(text)) return text;
  let cut = text;
  while (cut.length > 0 && !slackMarkdownFits(cut + CUT_NOTE)) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return cut + CUT_NOTE;
}

const refOf = (ref: string) =>
  Effect.fromOption(parseSlackRef(ref)).pipe(
    Effect.mapError(() => new ChannelError({ message: `${ref} is not a Slack conversation` })),
  );

/**
 * Slack over Socket Mode, so T3 needs no public URL: events arrive on a WebSocket, and posts go
 * through the Web API. It reads DMs and mentions from the user, and everything said in watched
 * channels.
 */
export const make = Effect.fn("SlackAdapter.make")(function* (settings: SlackSettings) {
  const http = yield* HttpClient.HttpClient;
  const scope = yield* Scope.Scope;
  const call = <A>(
    method: string,
    body: Record<string, unknown> | undefined,
    schema: Schema.Decoder<A>,
    token = settings.botToken,
    form = false,
  ) =>
    slackCall(settings.apiUrl, method, token, body, schema, form).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

  /** Uploads a file's bytes to Slack, not yet shared anywhere; returns its id. */
  const upload = Effect.fn("SlackAdapter.upload")(function* (file: ChannelFile) {
    const slot = yield* call(
      "files.getUploadURLExternal",
      { filename: file.name, length: String(file.size) },
      UploadSlot,
      settings.botToken,
      true,
    );
    const sent = yield* http
      .execute(
        HttpClientRequest.post(slot.upload_url).pipe(
          HttpClientRequest.bodyStream(file.bytes, {
            contentType: file.mimeType,
            contentLength: file.size,
          }),
        ),
      )
      .pipe(
        Effect.timeout("30 minutes"),
        Effect.mapError(() => new ChannelError({ message: `Could not upload ${file.name}` })),
      );
    if (sent.status !== 200) {
      return yield* new ChannelError({ message: `Slack refused ${file.name} (${sent.status})` });
    }
    return { id: slot.file_id, title: file.name };
  });

  const inbox = yield* Queue.unbounded<ChannelEvent>();
  const seen = new Set<string>();

  // Channel and people names, looked up once each; without the scopes for it, the ids stay.
  const names = new Map<string, string>();
  const lookup = (
    key: string,
    fallback: string,
    find: Effect.Effect<string | undefined, ChannelError>,
  ) =>
    names.has(key)
      ? Effect.succeed(names.get(key)!)
      : find.pipe(
          Effect.map((name) =>
            name === undefined || name.trim() === "" ? fallback : headerSafe(name),
          ),
          Effect.orElseSucceed(() => fallback),
          Effect.tap((name) => Effect.sync(() => names.set(key, name))),
        );
  // Always "@name": the header reads "from you" for the user, and a display name of "you" must
  // never pass for that.
  const personName = (user: string) =>
    lookup(
      `user:${user}`,
      `@${user}`,
      call(`users.info?user=${encodeURIComponent(user)}`, undefined, UserInfo).pipe(
        Effect.map((info) => {
          const name =
            info.user.profile?.display_name ||
            info.user.profile?.real_name ||
            info.user.real_name ||
            info.user.name;
          return name === undefined || name.trim() === "" ? undefined : `@${name}`;
        }),
      ),
    );
  const withNames = Effect.fn("SlackAdapter.withNames")(function* <
    M extends { readonly where: string; readonly author: string },
  >(message: M) {
    const channel = message.where.startsWith("#") ? message.where.slice(1) : null;
    const user = /^@([UW][A-Z0-9]+)$/u.exec(message.author)?.[1] ?? null;
    const where =
      channel === null
        ? message.where
        : `#${yield* lookup(
            `channel:${channel}`,
            channel,
            call(
              `conversations.info?channel=${encodeURIComponent(channel)}`,
              undefined,
              ConversationInfo,
            ).pipe(Effect.map((info) => info.channel.name)),
          )}`;
    const author = user === null ? message.author : yield* personName(user);
    return { ...message, where, author };
  });

  const connectOnce = (self: SlackSelf) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* call(
          "apps.connections.open",
          undefined,
          ConnectionsOpen,
          settings.appToken,
        );
        const frames = yield* Queue.unbounded<string | null>();
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocket(url)),
          (open) => Effect.sync(() => open.close()),
        );
        socket.addEventListener("message", (event) =>
          Queue.offerUnsafe(frames, String(event.data)),
        );
        socket.addEventListener("close", () => Queue.offerUnsafe(frames, null));
        socket.addEventListener("error", () => Queue.offerUnsafe(frames, null));
        while (true) {
          const raw = yield* Queue.take(frames);
          if (raw === null) return;
          const envelope = decodeEnvelope(raw);
          if (Option.isNone(envelope)) continue;
          // Slack redelivers anything not acknowledged within three seconds, so ack first.
          if (envelope.value.envelope_id !== undefined) {
            socket.send(encodeAck({ envelope_id: envelope.value.envelope_id }));
          }
          if (envelope.value.type === "disconnect") return;
          if (envelope.value.type !== "events_api") continue;
          const stop = readSlackStop(envelope.value.payload, settings.trustedUserId);
          if (stop !== null) {
            yield* Queue.offer(inbox, { type: "stop", ...stop });
            continue;
          }
          const outsider = readSlackOutsider(envelope.value.payload, settings, self.userId);
          if (outsider !== null) {
            yield* Queue.offer(inbox, { type: "outsider", ref: outsider });
            continue;
          }
          const message = readSlackMessage(envelope.value.payload, settings, self);
          // A mention arrives twice, as `message` and `app_mention`, with one id.
          if (Option.isNone(message) || seen.has(message.value.id)) continue;
          rememberBounded(seen, message.value.id);
          yield* Queue.offer(inbox, { type: "message", ...(yield* withNames(message.value)) });
        }
      }),
    );

  yield* Effect.forkIn(
    Effect.gen(function* () {
      const identity = yield* call("auth.test", undefined, AuthTest);
      yield* Effect.logInfo("Slack connected");
      // A dropped connection reconnects; Slack asks for this routinely with `disconnect`.
      return yield* connectOnce({ userId: identity.user_id, botId: identity.bot_id }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Slack connection lost", { cause })),
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.forever,
      );
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Slack did not start", { cause }))),
    scope,
  );

  /** The newest `limit` replies of a thread: Slack sends them oldest first, a page at a time. */
  const readThread = Effect.fn("SlackAdapter.read")(function* (ref: string, limit: number) {
    const target = yield* refOf(ref);
    let kept: Array<ChannelHistoryEntry> = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({
        channel: target.channel,
        ts: target.threadTs,
        limit: "200",
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page = yield* call(`conversations.replies?${query.toString()}`, undefined, Replies);
      for (const message of page.messages) {
        const fromUser = message.bot_id === undefined && message.user === settings.trustedUserId;
        const author =
          message.bot_id !== undefined || message.user === undefined
            ? "a bot"
            : fromUser
              ? "you"
              : yield* personName(message.user);
        kept.push({
          id: `slack:${target.channel}:${message.ts}`,
          author,
          fromUser,
          bot: message.bot_id !== undefined,
          text: message.text ?? "",
        });
      }
      kept = kept.slice(-limit);
      cursor = page.response_metadata?.next_cursor?.trim() || undefined;
    } while (cursor !== undefined);
    return kept;
  });

  return {
    name: "slack",
    prefix: "slack:",
    events: Stream.fromQueue(inbox),
    fileLimit: SLACK_FILE_LIMIT,
    mark: Effect.fn("SlackAdapter.mark")(function* (messageId, mark) {
      const target = yield* refOf(messageId);
      const reaction = (method: "reactions.add" | "reactions.remove", name: string) =>
        call(method, { channel: target.channel, timestamp: target.threadTs, name }, SlackOk).pipe(
          ignoreReactionState,
        );
      if (mark === "seen") return yield* reaction("reactions.add", "eyes");
      yield* reaction("reactions.remove", "eyes");
      yield* reaction("reactions.add", "white_check_mark");
    }),
    read: readThread,
    status: Effect.fn("SlackAdapter.status")(function* (ref, status) {
      const target = yield* refOf(ref);
      // Only DM threads are agent sessions; a channel thread has no session status.
      if (!target.channel.startsWith("D")) return;
      yield* call(
        "agents.sessions.setStatus",
        {
          channel_id: target.channel,
          thread_ts: target.threadTs,
          status: SESSION_STATUS[status],
        },
        SlackOk,
      );
    }),
    post: Effect.fn("SlackAdapter.post")(function* (ref, { text, files = [] }) {
      const target = yield* refOf(ref);
      const { blocks, fallback } = slackBlocks(fitted(text));
      const posted = yield* call(
        "chat.postMessage",
        {
          channel: target.channel,
          thread_ts: target.threadTs,
          // What notifications and clients without blocks show.
          text: escapeSlackText(plainLinks(fallback).slice(0, 3000)),
          blocks,
        },
        Posted,
      );
      if (files.length > 0) {
        const uploaded = yield* Effect.forEach(files, upload);
        yield* call(
          "files.completeUploadExternal",
          {
            files: encodeUploaded(uploaded),
            channel_id: target.channel,
            thread_ts: target.threadTs,
          },
          SlackOk,
          settings.botToken,
          true,
        );
      }
      return `slack:${posted.channel}:${posted.ts}`;
    }),
  } satisfies ChannelAdapter;
});
