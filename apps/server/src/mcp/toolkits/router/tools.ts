import {
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Proposals from "../../../router/Proposals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const routerDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  Proposals.Proposals,
];

const ProposeTaskTool = Tool.make("propose_task", {
  description:
    "Router only. Propose a new worker for the user to accept or discard in T3; nothing runs until they accept. For work a thread is already doing, use route_to_thread instead. `brief` is the worker's whole instruction. `workspaceStrategy` is where it runs: a new worktree from `baseRef`, the project's `root` folder, or an `existing_worktree` path. `agent` is `codex` or `claude`; each runs on the model super-t3's config sets for it. `relatedThreadIds` names threads that worked on something related (archived ones included), for the worker to read. Set `plan` to start with a plan for review.",
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    projectId: ProjectId,
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    agent: Schema.Literals(["codex", "claude"]),
    relatedThreadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(5))),
    plan: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ proposalId: ScheduledTaskId }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: routerDependencies,
})
  .annotate(Tool.Title, "Propose a task")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const RouteToThreadTool = Tool.make("route_to_thread", {
  description:
    "Router only. Pass new information straight to a worker thread already on that matter (not archived), with no proposal. `ref` is the one in the header of the channel message you are routing (leave it out only for what the user typed to you in T3). The worker gets that message, who wrote it, and your `note`. A message the user wrote also moves its conversation to that worker, which answers there. Someone else's message only reaches a worker that is working now.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    ref: Schema.optional(Schema.String),
    note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
  success: Schema.Struct({ routed: Schema.Literal(true) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: routerDependencies,
})
  .annotate(Tool.Title, "Route to a thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const RouterToolkit = Toolkit.make(ProposeTaskTool, RouteToThreadTool);
