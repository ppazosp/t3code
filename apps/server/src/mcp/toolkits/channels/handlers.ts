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

const handlers = {
  // Only the router speaks for the user outside T3; workers report to it instead.
  channel_reply: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "channel_reply");
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const shell = yield* threads
        .getThreadShell(thread.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || !isRouterThread(shell)) {
        return yield* failure("Only the router thread can reply in a channel.");
      }
      const channels = yield* Channels.Channels;
      yield* channels
        .reply(input.ref, input.text)
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { posted: true as const };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof ChannelsToolkit.tools>;

export const layer = McpToolAccess.toLayer(ChannelsToolkit, handlers);
