# super-t3

super-t3 is a fork of T3 Code that turns it into a super-agent. It keeps T3's own screen and adds three things: a router that turns what you say, in T3 or in Slack, into proposals; proposals you edit and accept before any work starts; and channels that report each worker back where you asked for it. It is based on the stable tag `v0.1.7`, kept on the `stable` branch, and takes upstream at stable tags.

## What it adds

- The router: one thread, tagged `router`. Opening super-t3 shows its conversation; until there is one, home offers to set it up. You talk to it instead of to each agent. It reads your projects and threads, and proposes work. It never starts work itself.
- Proposals: a section at the top of T3's sidebar, under the Router button, lists what the router proposed. Clicking one opens it as a card: its title and brief, then one row per setting, each with its icon (project, where it runs: a new worktree from a base branch, the project's folder or another folder, model, effort, start with a plan, and access). Change anything with T3's own pickers, then Accept, which starts a normal worker thread with full access and the proposal's title, or Discard. Accept is only on that card, with the brief and folder in view, because the router also reads messages other people write. Nothing runs, and nothing is spent, until you accept. A proposal is a paused T3 scheduled task with a far-off run time that marks it as the router's (`PROPOSAL_RUN_AT`), so T3 stores and syncs it and runs it on demand. The router chooses the model and effort for each proposal; an effort it names, such as low or high, is matched to the model's own control.
- Channels: outside conversations, each an adapter behind one interface (`apps/server/src/channels/Channel.ts`). Slack is the first. Your DMs and mentions, and every message in channels you choose, reach the router. When it proposes something from your own message, super-t3 says so in that Slack thread. When you accept it, the worker is tagged with that thread, its progress shows there as one message that follows the worker's plan step by step, and the message ends with the outcome and the worker's last message. When you reply in that thread (in a DM, or with a mention in a channel), your reply goes straight to the worker; when one conversation fed several workers, it goes to the router instead. Work proposed from someone else's message never posts in their thread. Progress messages live in memory, so a restart mid-run posts a fresh one for the next run rather than editing the old one.

## What the router can do

The server enforces these limits, whatever the router is told:

- Under Codex, its shell is read-only and never asks for approval. Under other providers, the router runs in "approval-required" mode, so it asks before it edits anything.
- It gets only these T3 tools: `orchestrator_capabilities`, `t3_project_list`, `t3_project_read`, `t3_thread_list`, `t3_thread_read`, `t3_thread_search`, `list_scheduled_tasks`, `propose_task` and `channel_reply`. They run without asking. Codex shows it only these, and T3's server refuses any other tool a router thread calls. It cannot start, message or delegate to a thread.
- `propose_task` only creates a paused proposal. Where a proposal came from is read from the router's last message, and only from a header the channel adapter wrote, so text in a message cannot fake it.
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

Fork code lives in its own files: `apps/web/src/components/router/`, `apps/server/src/router/`, `apps/server/src/channels/`, `apps/server/src/mcp/toolkits/channels/`, `apps/server/src/mcp/toolkits/router/` and `packages/contracts/src/router.ts`. The server keeps where each proposal came from in its own table, `super_t3_proposal_origins`, created on start; upstream migrations never see it.

These upstream files carry small edits, and are where a merge can conflict:

- `apps/web/src/components/Sidebar.tsx`: the Router button and the Proposals section above the threads, and the router left out of the thread list.
- `apps/web/src/routes/_chat.index.tsx`: the home page opens the router.
- `packages/client-runtime/src/operations/commands.ts` and `packages/client-runtime/src/state/threadCommands.ts`: a command to set a thread tag, which router setup uses.
- `packages/contracts/src/index.ts`: exports `router.ts`.
- `packages/provider-core/src/server/ProviderAdapter.ts`: `t3ToolAllowlist` on the runtime policy.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: applies that allowlist to T3's MCP servers.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: wraps the runtime policy with the router's.
- `apps/server/src/mcp/McpToolAccess.ts`: refuses tools outside the router's list.
- `apps/server/src/mcp/McpHttpServer.ts` and `apps/server/src/server.ts`: register `channel_reply` and `propose_task`, and start the channels and proposals.
- `apps/server/src/provider/agentContextBudget.json` and `AgentContextBudget.test.ts`: the tool list grew by `channel_reply` and `propose_task`.
