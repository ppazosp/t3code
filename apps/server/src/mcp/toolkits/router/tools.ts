import {
  ModelSelection,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  OrchestratorMcpFailure,
  ProjectId,
  ScheduledTaskId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Proposals from "../../../router/Proposals.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ProposeTaskTool = Tool.make("propose_task", {
  description:
    "Router only. Propose work for the user to accept or discard in T3; nothing runs until they accept. `brief` is the worker's whole instruction. `workspaceStrategy` is where it runs: a new worktree from `baseRef`, the project's `root` folder, or an `existing_worktree` path. Leave `modelSelection` out to use your own model. `effort` is a reasoning level such as low, medium or high. Set `plan` to start with a plan for review.",
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    projectId: ProjectId,
    workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
    modelSelection: Schema.optional(ModelSelection),
    effort: Schema.optional(Schema.String),
    plan: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({ proposalId: ScheduledTaskId }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Proposals.Proposals,
  ],
})
  .annotate(Tool.Title, "Propose a task")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const RouterToolkit = Toolkit.make(ProposeTaskTool);
