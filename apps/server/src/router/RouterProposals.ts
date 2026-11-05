import {
  CommandId,
  PROPOSAL_TAG,
  type OrchestrationV2ThreadShell,
  type ThreadId,
  type ThreadTag,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** Tools that start, message or hand work to another thread. A proposal waits for approval first. */
export const PROPOSAL_DENIED_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_send_attachments",
  "t3_thread_transfer",
  "t3_thread_organize",
  "t3_queue",
  "t3_pending_request",
  "schedule_task",
  "run_scheduled_task_now",
]);

export function isProposalThread(thread: Pick<OrchestrationV2ThreadShell, "tags">): boolean {
  return thread.tags?.includes(PROPOSAL_TAG) === true;
}

const SLACK_HEADER = /^\[slack [^\]\n]* ref=(slack:[A-Z0-9]+:\d+\.\d+)\]$/u;

/** The Slack ref in a header the channel adapter wrote; quoted lines below it never count. */
export function slackOriginOf(text: string): string | null {
  const header = text.split("\n", 1)[0] ?? "";
  return SLACK_HEADER.exec(header)?.[1] ?? null;
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
  const tags = [PROPOSAL_TAG, ...(origin === null ? [] : [origin])];
  for (const tag of tags) {
    yield* threads.dispatch({
      type: "thread.tag.set",
      commandId: CommandId.make(`router:tag:${input.threadId}:${tag}`),
      threadId: input.threadId,
      tag: tag as ThreadTag,
      tagged: true,
    });
  }
});
