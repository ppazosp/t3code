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

const handlers = {
  // Only the router proposes; workers delegate instead.
  propose_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "propose_task");
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const shell = yield* threads
        .getThreadShell(thread.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || !isRouterThread(shell)) {
        return yield* failure("Only the router thread can propose tasks.");
      }
      const proposals = yield* Proposals.Proposals;
      let target: Proposals.ProposeInput["target"];
      if (input.threadId !== undefined) {
        target = { type: "continue", threadId: input.threadId };
      } else if (
        input.projectId === undefined ||
        input.workspaceStrategy === undefined ||
        input.agent === undefined
      ) {
        return yield* failure(
          "A new worker needs projectId, workspaceStrategy and agent; to continue a thread, give threadId.",
        );
      } else {
        target = {
          type: "new",
          projectId: input.projectId,
          workspaceStrategy: input.workspaceStrategy,
          agent: input.agent,
        };
      }
      const { id } = yield* proposals
        .propose({
          routerId: thread.threadId,
          title: input.title,
          brief: input.brief,
          target,
          plan: input.plan ?? false,
        })
        .pipe(Effect.mapError((error) => failure(error.message)));
      return { proposalId: id };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof RouterToolkit.tools>;

export const layer = McpToolAccess.toLayer(RouterToolkit, handlers);
