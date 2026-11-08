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

const ProposeTaskTool = Tool.make("propose_task", {
  description:
    "Router only. Propose work for the user to accept or discard in T3; nothing runs until they accept. To continue a thread that already worked on this, give its `threadId`: the brief becomes its next message, and it keeps its own folder, model and context. An archived thread is not continued. Otherwise propose a new worker: `projectId`, `workspaceStrategy` (a new worktree from `baseRef`, the project's `root` folder, or an `existing_worktree` path), `agent` (`codex` or `claude`; each runs on the model super-t3's config sets for it), and `relatedThreadIds` for threads that worked on something related (archived ones included), which the brief names for the worker to read. `brief` is the whole instruction. Set `plan` to start with a plan for review.",
  parameters: Schema.Struct({
    title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
    brief: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20_000)),
    threadId: Schema.optional(ThreadId),
    projectId: Schema.optional(ProjectId),
    workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
    agent: Schema.optional(Schema.Literals(["codex", "claude"])),
    relatedThreadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(5))),
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
