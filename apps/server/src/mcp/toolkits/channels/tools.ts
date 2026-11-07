import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as Channels from "../../../channels/Channels.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ChannelReplyTool = Tool.make("channel_reply", {
  description:
    "Router only. Reply in the Slack channel or DM a message came from. `ref` is the one in that message's header. Plain text; mentions and links show as typed.",
  parameters: Schema.Struct({
    ref: Schema.String,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4000)),
  }),
  success: Schema.Struct({ posted: Schema.Literal(true) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Channels.Channels,
  ],
})
  .annotate(Tool.Title, "Reply in a channel")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const ChannelSayTool = Tool.make("channel_say", {
  description:
    "Workers only. Post in the channel conversation your task came from, such as a Slack thread, before you finish: a question you need answered, or a short note. Markdown, at most 3000 characters. Your final message is posted there by itself when you finish, so do not repeat it.",
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(3000)),
  }),
  success: Schema.Struct({ posted: Schema.Literal(true) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Channels.Channels,
  ],
})
  .annotate(Tool.Title, "Answer in your channel thread")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

const ChannelReadTool = Tool.make("channel_read", {
  description:
    "Router only. Read the latest messages of the conversation a channel message came from, oldest first. `ref` is the one in that message's header.",
  parameters: Schema.Struct({
    ref: Schema.String,
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    messages: Schema.Array(
      Schema.Struct({ author: Schema.String, fromUser: Schema.Boolean, text: Schema.String }),
    ),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Channels.Channels,
  ],
})
  .annotate(Tool.Title, "Read a channel conversation")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true);

export const ChannelsToolkit = Toolkit.make(ChannelReplyTool, ChannelSayTool, ChannelReadTool);
