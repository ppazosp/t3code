import { CommandId, MessageId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isRouterThread } from "../router/RouterRuntimePolicy.ts";
import {
  escapeSlackText,
  parseSlackRef,
  readSlackMessage,
  readSlackSettings,
  routerMessageText,
  SocketEnvelope,
  type ChannelMessage,
  type SlackSettings,
} from "./slack.ts";

export class ChannelError extends Schema.TaggedError<ChannelError>()("ChannelError", {
  message: Schema.String,
}) {}

export interface ChannelsShape {
  /** Posts the router's reply where a channel message came from, named by the `ref` it carried. */
  readonly reply: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
}

/**
 * Outside channels the router listens to. Each message the router should read is sent to the
 * router thread as a user message; the router answers through `reply`. Slack is the only channel
 * so far, configured by environment variables so the settings schema stays upstream's.
 */
export class Channels extends Context.Service<Channels, ChannelsShape>()("t3/channels/Channels") {}

const SlackOk = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });
const ConnectionsOpen = Schema.Struct({ url: Schema.String });
const AuthTest = Schema.Struct({ user_id: Schema.String });

const slackCall = Effect.fn("Channels.slackCall")(function* <A>(
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

const findRouter = (threads: ThreadManagementService.ThreadManagementService["Service"]) =>
  threads
    .listProjectThreads({ includeSubagents: false })
    .pipe(
      Effect.map((shells) =>
        Option.fromNullishOr(
          shells.find(
            (shell: OrchestrationV2ThreadShell) =>
              shell.archivedAt === null && isRouterThread(shell),
          ),
        ),
      ),
    );

const SEEN_LIMIT = 500;

function runSlack(
  settings: SlackSettings,
  threads: ThreadManagementService.ThreadManagementService["Service"],
) {
  const seen = new Set<string>();
  const deliver = Effect.fn("Channels.deliver")(
    function* (message: ChannelMessage) {
      if (seen.has(message.id)) return;
      seen.add(message.id);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.values().next().value!);
      const router = yield* findRouter(threads);
      if (Option.isNone(router)) {
        yield* Effect.logWarning("A Slack message arrived, but no thread is tagged as the router.");
        return;
      }
      yield* threads.sendToThread({
        projectId: router.value.projectId,
        // The Slack message's own id, so a redelivered event is the same command.
        commandId: CommandId.make(message.id),
        threadId: router.value.id,
        messageId: MessageId.make(message.id),
        text: routerMessageText(message),
        attachments: [],
        mode: "auto",
        createdBy: message.fromUser ? "user" : "system",
        creationSource: "server",
      });
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not pass a Slack message to the router", { cause }),
    ),
  );

  const connectOnce = (botUserId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const { url } = yield* slackCall(
          "apps.connections.open",
          settings.appToken,
          undefined,
          ConnectionsOpen,
        );
        const inbox = yield* Queue.unbounded<string | null>();
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocket(url)),
          (open) => Effect.sync(() => open.close()),
        );
        socket.addEventListener("message", (event) => Queue.offerUnsafe(inbox, String(event.data)));
        socket.addEventListener("close", () => Queue.offerUnsafe(inbox, null));
        socket.addEventListener("error", () => Queue.offerUnsafe(inbox, null));
        while (true) {
          const raw = yield* Queue.take(inbox);
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
          if (Option.isSome(message)) yield* deliver(message.value);
        }
      }),
    );

  return Effect.gen(function* () {
    const { user_id: botUserId } = yield* slackCall(
      "auth.test",
      settings.botToken,
      undefined,
      AuthTest,
    );
    yield* Effect.logInfo("Slack channel connected for the router");
    // A dropped connection reconnects; Slack asks for this routinely with `disconnect`.
    return yield* connectOnce(botUserId).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Slack connection lost", { cause })),
      Effect.andThen(Effect.sleep("2 seconds")),
      Effect.forever,
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Slack channel did not start", { cause })),
  );
}

const decodeEnvelope = Schema.decodeUnknownOption(Schema.fromJsonString(SocketEnvelope));
const encodeAck = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ envelope_id: Schema.String })),
);

const settingsConfig = Config.all({
  botToken: Config.String("T3_SLACK_BOT_TOKEN").pipe(Config.option),
  appToken: Config.String("T3_SLACK_APP_TOKEN").pipe(Config.option),
  trustedUserId: Config.String("T3_SLACK_TRUSTED_USER_ID").pipe(Config.option),
  watchedChannels: Config.String("T3_SLACK_WATCHED_CHANNELS").pipe(Config.option),
});

export const layer: Layer.Layer<
  Channels,
  never,
  ThreadManagementService.ThreadManagementService | HttpClient.HttpClient
> = Layer.effect(
  Channels,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const http = yield* HttpClient.HttpClient;
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
    if (Option.isSome(slack)) {
      yield* Effect.forkScoped(
        runSlack(slack.value, threads).pipe(Effect.provideService(HttpClient.HttpClient, http)),
      );
    }
    return Channels.of({
      reply: Effect.fn("Channels.reply")(function* (ref, text) {
        if (Option.isNone(slack)) {
          return yield* new ChannelError({ message: "No channel is connected to this T3." });
        }
        const target = parseSlackRef(ref);
        if (Option.isNone(target)) {
          return yield* new ChannelError({ message: `Unknown channel ref ${ref}.` });
        }
        yield* slackCall(
          "chat.postMessage",
          slack.value.botToken,
          {
            channel: target.value.channel,
            thread_ts: target.value.threadTs,
            text: escapeSlackText(text),
          },
          SlackOk,
        ).pipe(Effect.provideService(HttpClient.HttpClient, http));
      }),
    });
  }),
);
