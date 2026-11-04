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

export const ChannelsToolkit = Toolkit.make(ChannelReplyTool);
