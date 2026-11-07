import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as Channels from "../../../channels/Channels.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { isRouterThread } from "../../../router/RouterRuntimePolicy.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ChannelsToolkit } from "./tools.ts";

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The calling thread, and whether it is the router. */
const caller = Effect.fn("ChannelTools.caller")(function* (tool: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, tool);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  return { threadId: thread.threadId, router: shell !== null && isRouterThread(shell) };
});

const handlers = {
  // Only the router speaks for the user outside T3; workers answer only in their own thread.
  channel_reply: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      if (!(yield* caller("channel_reply")).router) {
        return yield* failure("Only the router thread can reply in a channel.");
      }
      const channels = yield* Channels.Channels;
      yield* channels
        .reply(input.ref, input.text)
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { posted: true as const };
    }),
  ),
  channel_say: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const self = yield* caller("channel_say");
      if (self.router) return yield* failure("The router answers with channel_reply.");
      const channels = yield* Channels.Channels;
      yield* channels
        .say(self.threadId, input.text)
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { posted: true as const };
    }),
  ),
  channel_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      if (!(yield* caller("channel_read")).router) {
        return yield* failure("Only the router thread can read channels.");
      }
      const channels = yield* Channels.Channels;
      const messages = yield* channels
        .read(input.ref, input.limit ?? 30)
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { messages };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ChannelsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ChannelsToolkit, handlers);
