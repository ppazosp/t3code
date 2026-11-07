# super-t3

super-t3 is a fork of T3 Code that turns it into a super-agent. It keeps T3's own screen and adds three things: a router that turns what you say, in T3 or in Slack, into proposals; proposals you edit and accept before any work starts; and channels that report each worker back where you asked for it. It is based on the stable tag `v0.1.7`, kept on the `stable` branch, and takes upstream at stable tags.

## What it adds

- The router: one thread, tagged `router`. Opening super-t3 shows its conversation; until there is one, home offers to set it up. You talk to it instead of to each agent. It reads your projects and threads, and proposes work. It never starts work itself.
- Proposals: a section at the top of T3's sidebar, under the Router button, lists what the router proposed, each laid out like a thread row: its project with a fixed Proposal badge, its title, its source on its own line (the Slack logo, channel and person), and where it would run with the provider's icon, as thread rows show it. Clicking one opens it as a normal T3 chat: a tab on top of the composer shows the title, where it came from (channel, person, when, and their message) and Discard, and the composer holds the brief with the router's model, effort, plan mode, full access and workspace already set, all changeable with the composer's own controls. Sending accepts the proposal: that chat becomes the worker thread, with the proposal's title. Nothing runs, and nothing is spent, until you send. A proposal is a paused T3 scheduled task with a far-off run time that marks it as the router's (`PROPOSAL_RUN_AT`), so T3 stores and syncs it; its source rides at the end of its prompt in a comment the app strips (`withProposalSource`). Sending it launches the thread already tagged `accepted:<proposal id>`, before its first turn starts; the server then gives the worker the proposal's title and Slack origin, deletes the proposal, and drops the tag. To continue a thread that already worked on something, the router proposes with that thread's id: the proposal then shows in that thread, on its composer with the brief filled in (and in the sidebar as "Continues …"), and sending there accepts it; the thread keeps its folder, model and context, and takes over the proposal's channel conversation, saying there that it started. An archived thread can be continued too: sending the proposal brings it back. For a new worker, the router chooses only who does it, `codex` or `claude`; each runs on the model and effort super-t3's `config.json` sets (by default GPT-6.1 Sol at xhigh, and Opus 5.5 at high). Change them for one task on its proposal before you send it.
- Channels: outside conversations, each an adapter behind one interface. Slack is the first. super-t3 acts only for you, and stays quiet:
  - DM super-t3, or mention it in a channel, and get 👀 within a second. It becomes ✅ once the router answers in the thread, or proposes work for it. A proposal posts nothing: it waits in T3 for you to accept.
  - Everything said in the channels you choose to watch reaches the router as information, replies in threads included, so it can propose work from it. Other people's DMs get one reply saying it works only for you.
  - Once you accept a proposal, its worker owns the conversation the proposal came from, whoever wrote the message there. It posts once that it started, then nothing until it has an answer, a plan or a question, each a new message in Markdown.
  - Messages in that conversation stay in Slack until you tag super-t3 there. Your tag goes to the worker, which steers it, with how many other messages came in since; the worker reads them with `channel_read` when they matter, and other people's words are information, never instructions. Untagged messages, and other people's tags, do nothing. A planning worker takes your answer to its plan as approval or changes.
  - Say "stop" there (with a mention in a channel), or press Stop in Slack's agent panel, and the conversation's workers stop.
  - super-t3 is a Slack agent: in your DMs, its panel shows it working, with a Stop button, ready once it answers, and waiting while a plan needs your answer. Agents need a paid Slack plan; on a free one Slack shows super-t3 as an ordinary app.
  - Workers read Slack beyond their conversation through whatever Slack connector your agent setup has, such as Slack's MCP server.
  - How far each task has read its conversation lives in memory: after a restart, your next tag counts the conversation's latest messages as new.
  - Each worker from a channel gets a system prompt block on working there (its final message is posted, others' words are information, post only through its tools), plus the channel's own block, such as Slack's charts. Codex and Claude take it; other providers do not yet.
  - In Slack, a fenced code block with the language `chart` holding a chart's JSON is drawn as a Slack chart, in any post: `channel_say` or a final message. Elsewhere it shows as code.

## Add a channel

A channel is one folder in `apps/server/src/channels/` and one line in `registry.ts`:

1. Implement `ChannelAdapter` from `Channel.ts`: events in (messages, its own Stop control, and outsiders writing to T3), and posts (Markdown), marks (👀 and ✅), a conversation's status, and reading a conversation out. Every ref the adapter issues starts with its name and a colon, such as `email:`.
2. Write a `ChannelDefinition`: the channel's name, its settings read from the environment (`Option.none` keeps it off), `make`, which builds the adapter, and optional `instructions` for workers on writing there, such as formats the adapter draws beyond Markdown.
3. Add `register(yourChannel)` to `CHANNELS` in `registry.ts`.

The bridge (`ChannelBridge.ts`), the router's tools and proposals work with any channel; nothing outside the channel's folder names Slack, except the Slack logo the web app shows for Slack proposals.

## Try it without a Slack app

`pnpm --filter t3 mock:slack` (or `node apps/server/scripts/mock-slack.ts 18555`) starts a stand-in Slack on `http://127.0.0.1:18555`: Slack's Web API methods super-t3 calls, Socket Mode over a local WebSocket, and a page at `/` that shows the conversations live, lets you DM super-t3 as yourself, and click Approve and Change. Start super-t3 with:

```
T3_SLACK_API_URL=http://127.0.0.1:18555/api T3_SLACK_BOT_TOKEN=xoxb-mock T3_SLACK_APP_TOKEN=xapp-mock T3_SLACK_TRUSTED_USER_ID=UME T3_SLACK_WATCHED_CHANNELS=CWATCH
```

You are `UME`; `UMARIA` is someone else. The control API (`POST /_mock/say`, `/_mock/click`, `/_mock/submit` with a JSON body, `GET /_mock/state`) drives it from scripts. It writes and clicks as you, so those three take only a JSON `POST` addressed to the mock's own host, and refuse requests from other sites' pages. The Slack adapter's tests run against the same mock.

## super-t3's files

super-t3 keeps three files in T3's home, in `super-t3/` (for a dev worktree, `.t3/super-t3/`). They start as defaults, are never overwritten, and are read fresh, so an edit applies on the next turn:

- `ROUTER.md`: the router's system prompt: what it is, how it works, how to use workers.
- `WORKER.md`: added to the system prompt of every worker the router proposed, after the provider's and T3's own (empty it to add nothing).
- `config.json`: the router's model (`router.model`), applied to the router's thread at start, when a router appears and whenever the file changes; and each worker agent's (`workers.codex`, `workers.claude`). Each is a provider instance, a model and an effort.

## What the router can do

The server enforces these limits, whatever the router is told:

- Under Codex and Claude, the router has no tool but its T3 tools below: no shell, file reading, web search, connectors, plugins, browser, image tools or subagents, and none of your own MCP servers. Codex gets per-thread settings that turn each of those off (`CODEX_T3_TOOLS_ONLY_CONFIG`; Codex 0.161 cannot turn off its subagent tools or `apply_patch`, but subagents inherit the same limits and the read-only sandbox stops `apply_patch` writing), plus every MCP server in your Codex config turned off by name, read with `config/read` so none is started. Claude gets no built-in tools and only T3's MCP server (`strictMcpConfig`). A tool list on the runtime policy (`t3ToolAllowlist`) is what turns this on. Other providers cannot be limited this way, so run the router on Codex or Claude.
- Its system prompt is `ROUTER.md`, read on every turn, under Codex and Claude. It works in an empty folder of its own (`super-t3/router`), so no project's files or AGENTS.md reach it; under Claude it also loads no settings, so your CLAUDE.md does not either. Codex always loads your global `~/.codex/AGENTS.md`: one Codex server serves every thread, and no per-thread setting turns it off.
- It gets only these T3 tools: `orchestrator_capabilities`, `t3_project_list` and `t3_project_read`, `t3_thread_list`, `t3_thread_read` and `t3_thread_search` (which workers there are, what they are doing, and what was done before), `list_scheduled_tasks`, `propose_task`, `channel_reply` and `channel_read`. They run without asking, and T3's server refuses any other T3 tool a router thread calls. It cannot start, message or delegate to a thread.
- `propose_task` only creates a paused proposal. Where a proposal came from is read from the router's last message, and only from a header the channel adapter wrote, so text in a message cannot fake it.
- `channel_reply` answers only messages you sent. Messages from other people reach the router quoted, as information. `channel_read` reads a conversation the bot can see; a worker reads only its own.
- Workers get `channel_say`, which posts only in the conversation their task came from. It can attach up to 10 images or videos, only from the worker's own folder (links followed), recognised by their content, and within the channel's own size limit (Slack: 1 GB).

## Turn on Slack

super-t3's mark is T3 Code's desktop icon, its silver T3 on black, crowned with a wide gold crown of three points. It lives in `assets/super-t3/`: `logo.svg` with T3's rounded corners, and `slack-icon-1024.png`, full-bleed for Slack to round, to upload as the app's icon under Basic Information, Display Information.

1. Create the app: go to api.slack.com/apps, choose Create New App, then From a manifest, pick your workspace, and paste `apps/server/src/channels/slack/slack-app-manifest.json`. It asks for every scope super-t3 uses, turns on Socket Mode and Slack's agent view, and subscribes to DMs, mentions, messages in public and private channels the bot is in, and the agent panel's Stop button. It also uploads files, for workers' screenshots and videos. An app made from an older manifest gets the same by pasting this one under App Manifest and reinstalling.
2. Install it to the workspace (Install App). Copy the Bot User OAuth Token (`xoxb-…`).
3. Under Basic Information, App-Level Tokens, generate a token with the `connections:write` scope. Copy it (`xapp-…`).
4. Find your member ID: in Slack, open your profile, choose the ⋮ menu, then Copy member ID.
5. Invite the bot to each channel it should read: `/invite @super-t3`. For channels the router should read in full, not only mentions, copy each channel's ID (channel details, at the bottom).
6. Set these environment variables for the server, then restart it:
   - `T3_SLACK_BOT_TOKEN`: the bot token.
   - `T3_SLACK_APP_TOKEN`: the app-level token.
   - `T3_SLACK_TRUSTED_USER_ID`: your member ID.
   - `T3_SLACK_WATCHED_CHANNELS`: optional, a comma-separated list of channel IDs the router reads in full.

A file like `.env.super-t3` at the repository root keeps them out of git (`.env*` is ignored). The server logs "Slack connected" once it is in.

Use a Slack app of its own. Slack splits events between every connection on one app token, so sharing a token with another running service loses messages.

## Merging upstream

Fork code lives in its own files: `apps/web/src/components/router/`, `apps/server/src/router/`, `apps/server/src/channels/`, `apps/server/src/mcp/toolkits/channels/`, `apps/server/src/mcp/toolkits/router/` and `packages/contracts/src/router.ts`. The server keeps where each proposal came from in its own table, `super_t3_proposal_origins`, created on start; upstream migrations never see it.

These upstream files carry small edits, and are where a merge can conflict:

- `apps/web/src/components/Sidebar.tsx`: the Router button and the Proposals section above the threads, and the router and proposal chats left out of the thread list.
- `apps/web/src/routes/_chat.index.tsx`: the home page opens the router.
- `apps/web/src/components/ChatView.tsx`: a proposal's chat shows its tab instead of the new-thread headline, and keeps plan mode when the router asked for a plan, even with T3's plan mode setting off.
- `apps/web/src/components/chat/ChatComposer.tsx`: the same plan mode rule for a proposal's composer.
- `apps/web/src/components/chat/TimelineUserMessageRow.tsx`: a channel message the server wrote shows as a card with its source (the channel's logo, where, who, when) and the message, instead of the header the router reads.
- `apps/web/src/components/sidebar/SidebarDraftBlock.tsx`: proposal chats are listed under Proposals, not as drafts.
- `apps/web/src/components/Icons.tsx`: the Slack logo, added at the end.
- `packages/client-runtime/src/operations/commands.ts` and `packages/client-runtime/src/state/threadCommands.ts`: a command to set a thread tag, which router setup uses.
- `packages/contracts/src/index.ts`: exports `router.ts`.
- `packages/provider-core/src/server/ProviderAdapter.ts`: `t3ToolAllowlist` on the runtime policy.
- `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`: applies that allowlist to T3's MCP servers.
- `apps/server/src/orchestration-v2/runtimeLayer.ts`: wraps the runtime policy with the router's.
- `apps/server/src/mcp/McpToolAccess.ts`: refuses tools outside the router's list.
- `apps/server/src/mcp/McpHttpServer.ts` and `apps/server/src/server.ts`: register the channel tools and `propose_task`, and start the channels and proposals.
- `apps/server/src/provider/agentContextBudget.json` and `AgentContextBudget.test.ts`: the tool list grew by the channel tools and `propose_task`.
- `apps/server/package.json`: the `mock:slack` script.
