# super-t3

super-t3 is a fork of T3 Code that turns it into a super-agent: a task board, a router that turns what you say (in T3 or in Slack) into proposed tasks, and channels that report each task back where it came from. It sits on top of upstream. It is based on the stable tag `v0.1.7`, kept on the `stable` branch, and takes upstream at stable tags.

## What it adds

- Tasks: T3's main sidebar shows threads as tasks. A thread's delegated threads are its subtasks. Narrow, the sidebar lists them by status beside the open thread. Drag it wider than 600 px, or press Task board at its top, and it becomes the task board, with the thread you have open still beside it. The board has three columns: Proposed (waiting for your approval, with Discard and Approve on each card; Discard archives it), Needs you (approvals, questions and failures, with running work in a Working section at its foot) and Ready for review (finished work, for example waiting for you to merge). Like Linear, Done and Snoozed are hidden columns, listed at the right of the board with their counts; click one to see its tasks. Each card shows its worktree and its model on their own lines, lists up to three subtasks with their status (more are counted), and carries the thread sidebar's actions: hover buttons to mark done and snooze, and the full thread menu on right-click or the "…" button, with a Status submenu. Dropping a card on Done settles it.
- Inside a thread, the details panel on the right starts with the task: its title, its status (which you can change), the task it belongs to, its subtasks, and Approve for a proposal.
- The router: one thread, tagged `router`, and the home page: opening super-t3 shows its conversation beside the task sidebar. Until there is a router, home offers to set one up. It reads, proposes tasks and follows them. It does not do the work itself.
- Channels: outside conversations, each an adapter behind one interface (`apps/server/src/channels/Channel.ts`). Slack is the first. Your DMs and mentions, and every message in channels you choose, reach the router. What it proposes from them waits in the Proposed column, with the Slack logo. When the proposal came from your own message, super-t3 says so in that Slack thread and reports the task there; a task proposed from someone else's message never posts in their thread (it is tagged `from-you` only when you wrote the message). You approve in T3, never in Slack. Once you do, the task's progress shows in that thread as one message that follows the task's plan, step by step, and ends with its outcome and its last message. When you reply in that thread (in a DM, or with a mention in a channel), your reply goes straight to the task; when one conversation fed several tasks, it goes to the router instead. Progress messages live in memory, so a restart mid-run posts a fresh one for the next run rather than editing the old one.

## What the router can do

The server enforces these limits, whatever the router is told:

- Under Codex, its shell is read-only and never asks for approval. Under other providers, the router runs in "approval-required" mode, so it asks before it edits anything.
- It gets only these T3 tools: `orchestrator_capabilities`, `t3_project_list`, `t3_project_read`, `t3_thread_launch`, `t3_thread_list`, `t3_thread_read`, `t3_thread_search`, `list_scheduled_tasks` and `channel_reply`. They run without asking. Codex shows it only these, and T3's server refuses any other tool a router thread calls.
- Every thread it starts is a proposal, tagged `proposal`. It runs in plan mode and "auto-accept-edits" mode, which can write only inside its own workspace and has no network. Until you press Approve, on the card, in the list or in its details panel, T3 lets it call only its read tools (listing and reading threads and projects), so it cannot delegate, message other threads or change anything through T3. The router cannot launch into a linked environment, where its launch would arrive untagged. Approve removes the tag and gives the task full access, so it can push and use the network. When the router was reading a Slack message, the proposal is also tagged with that message (`slack:<channel>:<ts>`), and its card shows the Slack logo.
- `channel_reply` answers only messages you sent. Messages from other people reach the router quoted, as information.

## Turn on Slack

Set these environment variables for the server, then restart it:

- `T3_SLACK_BOT_TOKEN`: the bot token (`xoxb-…`). It needs the `chat:write`, `im:history`, `channels:history` and `app_mentions:read` scopes.
- `T3_SLACK_APP_TOKEN`: an app-level token (`xapp-…`) with `connections:write`, for Socket Mode.
- `T3_SLACK_TRUSTED_USER_ID`: your Slack member ID.
- `T3_SLACK_WATCHED_CHANNELS`: optional, a comma-separated list of channel IDs the router reads in full.

Turn on Socket Mode for the app, and subscribe it to the `message.im`, `message.channels` and `app_mention` events.

Use a Slack app of its own. Slack splits events between every connection on one app token, so sharing a token with another running service loses messages.

## Merging upstream

Fork code lives in its own files: `apps/web/src/components/tasks/`, `apps/server/src/router/`, `apps/server/src/channels/`, `apps/server/src/mcp/toolkits/channels/` and `packages/contracts/src/router.ts`.

These upstream files carry small edits, and are where a merge can conflict:

- `apps/web/src/components/AppSidebarLayout.tsx`: the task sidebar replaces the thread sidebar, and gets the sidebar's width.
- `apps/web/src/components/threadSidebarWidth.ts`: the chat beside the sidebar may be 512 px instead of 640, so the board fits.
- `apps/web/src/components/chat/ThreadDetailsPanel.tsx`: the task section at the top of the details panel.
- `apps/web/src/components/Icons.tsx`: the Slack logo, added at the end.
- `apps/web/src/routes/_chat.index.tsx`: the home page opens the router.
- `packages/client-runtime/src/operations/commands.ts` and `packages/client-runtime/src/state/threadCommands.ts`: a command to set a thread tag.
- `packages/contracts/src/index.ts`: exports `router.ts`.
- `packages/provider-core/src/server/ProviderAdapter.ts`: `t3ToolAllowlist` on the runtime policy.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: applies that allowlist to T3's MCP servers.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: wraps the runtime policy with the router's.
- `apps/server/src/mcp/threadAccess.ts` and `apps/server/src/mcp/OrchestratorMcpService.ts`: cap what the router starts.
- `apps/server/src/mcp/McpToolAccess.ts`: refuses tools outside the router's list, and thread-starting tools to a proposal.
- `apps/server/src/mcp/toolkits/project/handlers.ts`: tags what the router launches as a proposal.
- `apps/server/src/mcp/McpHttpServer.ts` and `apps/server/src/server.ts`: register `channel_reply` and the channels with their bridge.
- `apps/server/src/provider/agentContextBudget.json` and `AgentContextBudget.test.ts`: the tool list grew by `channel_reply`.
