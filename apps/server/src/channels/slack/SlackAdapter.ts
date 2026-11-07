import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { ChannelError, type ChannelAdapter, type ChannelMessage } from "../Channel.ts";
import {
  escapeSlackText,
  parseSlackRef,
  readSlackMessage,
  SocketEnvelope,
  type SlackSettings,
} from "./parse.ts";
import { progressContent } from "./progress.ts";

const SlackOk = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });
const ConnectionsOpen = Schema.Struct({ url: Schema.String });
const AuthTest = Schema.Struct({ user_id: Schema.String });
const Posted = Schema.Struct({ channel: Schema.String, ts: Schema.String });
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

/**
 * A name safe inside the router's message header. Brackets and newlines would break it, and the
 * header's own words (" from ", " ref=") must not appear in a name anyone can choose.
 */
const headerSafe = (name: string) =>
  name
    .replaceAll(/[\]\[\n\r]/gu, " ")
    .replaceAll(/\s(from|ref=)\s?/giu, " ")
    .trim();

/** Slack allows about one edit of a message a second. */
const EDIT_SPACING_MS = 1_000;

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
  method: string,
  token: string,
  body: Record<string, unknown> | undefined,
  schema: Schema.Decoder<A>,
) {
  const client = yield* HttpClient.HttpClient;
  const unknownReply = () => new ChannelError({ message: `Slack ${method} sent an unknown reply` });
  const request = HttpClientRequest.post(`https://slack.com/api/${method}`).pipe(
    HttpClientRequest.setHeaders({ Authorization: `Bearer ${token}` }),
    body === undefined ? (same) => same : HttpClientRequest.bodyJsonUnsafe(body),
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
  ) =>
    slackCall(method, token, body, schema).pipe(Effect.provideService(HttpClient.HttpClient, http));

  const inbox = yield* Queue.unbounded<ChannelMessage>();
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
  const withNames = Effect.fn("SlackAdapter.withNames")(function* (message: ChannelMessage) {
    const channel = message.where.startsWith("#") ? message.where.slice(1) : null;
    const user = message.author.startsWith("@") ? message.author.slice(1) : null;
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
    const author =
      user === null
        ? message.author
        : // Always "@name": the header reads "from you" for the user, and a display name of "you"
          // must never pass for that.
          yield* lookup(
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
    return { ...message, where, author };
  });

  const connectOnce = (botUserId: string) =>
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
          const message = readSlackMessage(envelope.value.payload, settings, botUserId);
          // A mention arrives twice, as `message` and `app_mention`, with one id.
          if (Option.isNone(message) || seen.has(message.value.id)) continue;
          rememberBounded(seen, message.value.id);
          yield* Queue.offer(inbox, yield* withNames(message.value));
        }
      }),
    );

  yield* Effect.forkIn(
    Effect.gen(function* () {
      const { user_id: botUserId } = yield* call("auth.test", undefined, AuthTest);
      yield* Effect.logInfo("Slack connected");
      // A dropped connection reconnects; Slack asks for this routinely with `disconnect`.
      return yield* connectOnce(botUserId).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Slack connection lost", { cause })),
        Effect.andThen(Effect.sleep("2 seconds")),
        Effect.forever,
      );
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Slack did not start", { cause }))),
    scope,
  );

  // The latest content waiting for each progress message, written at most once a second.
  const edits = new Map<
    string,
    {
      pending: ReturnType<typeof progressContent> | null;
      running: boolean;
      lastWrite: number;
      /** The run ended; once its last edit is written the message is forgotten. */
      final: boolean;
    }
  >();
  const drain = Effect.fn("SlackAdapter.drainProgress")(function* (
    message: string,
    channel: string,
    ts: string,
  ) {
    const state = edits.get(message)!;
    while (state.pending !== null) {
      const now = yield* Clock.currentTimeMillis;
      yield* Effect.sleep(Math.max(0, state.lastWrite + EDIT_SPACING_MS - now));
      const content = state.pending;
      state.pending = null;
      state.lastWrite = yield* Clock.currentTimeMillis;
      yield* call("chat.update", { channel, ts, ...content }, SlackOk).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not update a Slack progress message", { cause }),
        ),
      );
    }
    state.running = false;
    if (state.final) edits.delete(message);
  });

  return {
    prefix: "slack:",
    messages: Stream.fromQueue(inbox),
    post: Effect.fn("SlackAdapter.post")(function* (ref, text) {
      const target = yield* refOf(ref);
      yield* call(
        "chat.postMessage",
        { channel: target.channel, thread_ts: target.threadTs, text: escapeSlackText(text) },
        SlackOk,
      );
    }),
    showProgress: Effect.fn("SlackAdapter.showProgress")(function* ({ ref, message, progress }) {
      const content = progressContent(progress);
      if (message === null) {
        const target = yield* refOf(ref);
        const posted = yield* call(
          "chat.postMessage",
          { channel: target.channel, thread_ts: target.threadTs, ...content },
          Posted,
        );
        const key = `slack:${posted.channel}:${posted.ts}`;
        if (progress.finished === null) {
          edits.set(key, {
            pending: null,
            running: false,
            lastWrite: yield* Clock.currentTimeMillis,
            final: false,
          });
        }
        return key;
      }
      const target = yield* refOf(message);
      const state = edits.get(message) ?? {
        pending: null,
        running: false,
        lastWrite: 0,
        final: false,
      };
      edits.set(message, state);
      state.pending = content;
      if (progress.finished !== null) state.final = true;
      if (!state.running) {
        state.running = true;
        yield* Effect.forkIn(drain(message, target.channel, target.threadTs), scope);
      }
      return message;
    }),
  } satisfies ChannelAdapter;
});
