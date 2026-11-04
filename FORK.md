# This fork

This fork of T3 Code adds a task view and a router on top of upstream. It is based on the stable tag `v0.1.7`, kept on the `stable` branch, and takes upstream at stable tags.

## What it adds

- Tasks: a page at `/tasks`, opened from the sidebar, that shows threads as tasks in a board or a list. A thread's delegated threads are its subtasks. Columns: Proposed, Todo, In progress, Needs you, In review, Done and Snoozed. Dropping a card on Done settles it.
- The router: one thread, tagged `router`, that you talk to from the top of the Tasks page. It reads, proposes tasks and follows them. It does not do the work itself.
- Channels: Slack DMs and mentions from you, and every message in channels you choose, reach the router. It can reply to your messages in Slack.

## What the router can do

The server enforces these limits, whatever the router is told:

- Under Codex, its shell is read-only and never asks for approval. Under other providers, the router runs in "approval-required" mode, so it asks before it edits anything.
- It gets only these T3 tools: `orchestrator_capabilities`, `t3_project_list`, `t3_project_read`, `t3_thread_launch`, `t3_thread_list`, `t3_thread_read`, `t3_thread_search`, `list_scheduled_tasks` and `channel_reply`. They run without asking. Codex shows it only these, and T3's server refuses any other tool a router thread calls.
- Every thread it starts is a proposal. It runs in plan mode and "auto-accept-edits" mode, which can write only inside its own workspace and has no network. It waits until you press Approve, on the card or in the list. Approve with full access gives the task full access.
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

Fork code lives in its own files: `apps/web/src/components/tasks/`, `apps/web/src/routes/_chat.tasks.tsx`, `apps/server/src/router/`, `apps/server/src/channels/`, `apps/server/src/mcp/toolkits/channels/` and `packages/contracts/src/router.ts`.

These upstream files carry small edits, and are where a merge can conflict:

- `apps/web/src/components/sidebar/SidebarChrome.tsx`: the Tasks button.
- `apps/web/src/components/sidebar/mainAppLocation.ts`: `/tasks` is a utility page.
- `apps/web/src/routeTree.gen.ts`: generated; regenerate it rather than merging it.
- `packages/client-runtime/src/operations/commands.ts` and `packages/client-runtime/src/state/threadCommands.ts`: a command to set a thread tag.
- `packages/contracts/src/index.ts`: exports `router.ts`.
- `packages/provider-core/src/server/ProviderAdapter.ts`: `t3ToolAllowlist` on the runtime policy.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: applies that allowlist to T3's MCP servers.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: wraps the runtime policy with the router's.
- `apps/server/src/mcp/threadAccess.ts` and `apps/server/src/mcp/OrchestratorMcpService.ts`: cap what the router starts.
- `apps/server/src/mcp/McpToolAccess.ts`: refuses tools outside the router's list.
- `apps/server/src/mcp/McpHttpServer.ts` and `apps/server/src/server.ts`: register `channel_reply` and the channel listener.
- `apps/server/src/provider/agentContextBudget.json` and `AgentContextBudget.test.ts`: the tool list grew by `channel_reply`.
