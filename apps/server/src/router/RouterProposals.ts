import {
  CommandId,
  FROM_USER_TAG,
  PROPOSAL_TAG,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadTag,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/**
 * The T3 tools a proposal may call before the user approves it: reading and listing. Anything else,
 * such as delegating, messaging another thread or changing settings, waits for approval.
 */
export const PROPOSAL_TOOLS: ReadonlySet<string> = new Set([
  "orchestrator_capabilities",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "list_scheduled_tasks",
]);

/**
 * Threads the router is launching whose tag is not stored yet. A launch starts the first turn before
 * a tag can be set, so the id counts as a proposal from the moment it is chosen. A failed tag keeps
 * the id here, so the thread stays limited until the server restarts.
 */
const launching = new Set<string>();

export function beginRouterLaunch(threadId: ThreadId): void {
  launching.add(threadId);
}

export function isProposalThread(thread: Pick<OrchestrationV2ThreadShell, "id" | "tags">): boolean {
  return thread.tags?.includes(PROPOSAL_TAG) === true || launching.has(thread.id);
}

const SLACK_HEADER = /^\[slack [^\]\n]* ref=(slack:[A-Z0-9]+:\d+\.\d+)\]$/u;

/** The Slack ref in a header the channel adapter wrote; quoted lines below it never count. */
export function slackOriginOf(text: string): string | null {
  const header = text.split("\n", 1)[0] ?? "";
  return SLACK_HEADER.exec(header)?.[1] ?? null;
}

/** Whether the header says the user wrote the message, as the channel adapter writes it. */
export function isFromUser(text: string): boolean {
  const header = text.split("\n", 1)[0] ?? "";
  return SLACK_HEADER.test(header) && /^\[slack \S+ from you ref=/u.test(header);
}

/**
 * Tags a thread the router just launched as a proposal, and with the Slack message the router was
 * reading when it launched it. Only a message the server wrote counts, so typed text cannot fake an
 * origin.
 */
export const markRouterLaunch = Effect.fn("RouterProposals.markRouterLaunch")(function* (input: {
  readonly routerId: ThreadId;
  readonly threadId: ThreadId;
}) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const router = yield* threads.getThreadProjection(input.routerId);
  const trigger = router.messages.findLast((message) => message.role === "user");
  const origin =
    trigger?.creationSource === "server" && trigger.text.startsWith("[slack ")
      ? slackOriginOf(trigger.text)
      : null;
  const fromUser = origin !== null && trigger !== undefined && isFromUser(trigger.text);
  const tags = [
    PROPOSAL_TAG,
    ...(origin === null ? [] : [origin]),
    ...(fromUser ? [FROM_USER_TAG] : []),
  ];
  for (const tag of tags) {
    yield* threads.dispatch({
      type: "thread.tag.set",
      commandId: CommandId.make(`router:tag:${input.threadId}:${tag}`),
      threadId: input.threadId,
      tag: tag as ThreadTag,
      tagged: true,
    });
  }
  launching.delete(input.threadId);
});
