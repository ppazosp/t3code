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

const DispatchWorkerTool = Tool.make("dispatch_worker", {
  description:
    "Router only. Start a new worker. It starts at once when the user asked you for this work themselves (typed to you in T3, or sent to you in a channel: `to me` in the header); anything else, or `propose: true`, becomes a proposal the user accepts or discards in T3. The result says which happened, with a \`link\` to a started worker to put in your reply. For work a thread is already doing, use route_to_thread instead. `brief` is the worker's whole instruction. `workspaceStrategy` is where it runs: a new worktree from `baseRef`, the project's `root` folder, or an `existing_worktree` path. `agent` is `codex` or `claude`; each runs on the model super-t3's config sets for it. `relatedThreadIds` names threads that worked on something related (archived ones included), for the worker to read. Set `plan` to start with a plan for review. Set `propose` to have the user accept it first, such as when you had to guess the project or the scope.",
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    projectId: ProjectId,
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    agent: Schema.Literals(["codex", "claude"]),
    relatedThreadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(5))),
    plan: Schema.optional(Schema.Boolean),
    propose: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Union([
    Schema.Struct({ outcome: Schema.Literal("started"), threadId: ThreadId, link: Schema.String }),
    Schema.Struct({
      outcome: Schema.Literal("proposed"),
      // Named so T3 keeps it in what clients see of the result, for the proposal's card.
      scheduledTaskId: ScheduledTaskId,
      note: Schema.optional(Schema.String),
    }),
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: routerDependencies,
})
  .annotate(Tool.Title, "Dispatch a worker")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const RouteToThreadTool = Tool.make("route_to_thread", {
  description:
    "Router only. Pass new information straight to a worker thread already on that matter (not archived), with no proposal. `ref` is the one in the header of the channel message you are routing (leave it out only for what the user typed to you in T3 or a worker's request). The worker gets that message, who wrote it, and your `note`. A message the user wrote also moves its conversation to that worker, which answers there. Someone else's message only reaches a worker that is working now.",
  parameters: Schema.Struct({
    threadId: ThreadId,
    ref: Schema.optional(Schema.String),
    note: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
  success: Schema.Struct({ routed: Schema.Literal(true), link: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: routerDependencies,
})
  .annotate(Tool.Title, "Route to a thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

const RequestWorkerTool = Tool.make("request_worker", {
  description:
    "Workers only. Ask the router for a new worker, for work outside your task that no thread is doing. `request` is self-contained: what to do, why, where, and what done looks like. The router checks whether a thread already does it and otherwise proposes a worker for the user to accept. It does not answer you; carry on with your task.",
  parameters: Schema.Struct({
    request: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
  success: Schema.Struct({ sent: Schema.Literal(true) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: routerDependencies,
})
  .annotate(Tool.Title, "Ask the router for a worker")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const RouterToolkit = Toolkit.make(DispatchWorkerTool, RouteToThreadTool, RequestWorkerTool);
