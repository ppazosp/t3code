import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Proposals from "../../../router/Proposals.ts";
import { isRouterThread } from "../../../router/RouterRuntimePolicy.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { RouterToolkit } from "./tools.ts";

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

/** The calling thread, which must be the router. */
const routerCaller = Effect.fn("RouterTools.caller")(function* (tool: string) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, tool);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const shell = yield* threads
    .getThreadShell(thread.threadId)
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || !isRouterThread(shell)) {
    return yield* failure("Only the router thread can do this.");
  }
  return thread.threadId;
});

const handlers = {
  // Only the router proposes and routes; workers delegate instead.
  propose_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const routerId = yield* routerCaller("propose_task");
      const proposals = yield* Proposals.Proposals;
      const { id } = yield* proposals
        .propose({
          routerId,
          title: input.title,
          brief: input.brief,
          projectId: input.projectId,
          workspaceStrategy: input.workspaceStrategy,
          agent: input.agent,
          relatedThreadIds: input.relatedThreadIds ?? [],
          plan: input.plan ?? false,
        })
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { proposalId: id };
    }),
  ),
  route_to_thread: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const routerId = yield* routerCaller("route_to_thread");
      const proposals = yield* Proposals.Proposals;
      yield* proposals
        .route({ routerId, threadId: input.threadId, ref: input.ref, note: input.note })
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { routed: true as const };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof RouterToolkit.tools>;

export const layer = McpToolAccess.toLayer(RouterToolkit, handlers);
