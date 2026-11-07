import {
  FROM_USER_TAG,
  PROPOSAL_TAG,
  ROUTER_TAG,
  type OrchestrationV2PlanStep,
} from "@t3tools/contracts";

import type { ChannelMessage, ProgressStep } from "./Channel.ts";

/** What the bridge knows about a thread, kept current from T3's events. */
export interface BridgeThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly tags: ReadonlyArray<string>;
  readonly interactionMode: "default" | "plan";
  readonly archived: boolean;
}

/**
 * The conversation a task came from: the router tags what it proposes from a channel message with
 * that message's ref, such as `slack:<channel>:<thread ts>`.
 */
export function originOf(
  thread: Pick<BridgeThread, "tags">,
  prefixes: ReadonlyArray<string>,
): string | null {
  return thread.tags.find((tag) => prefixes.some((prefix) => tag.startsWith(prefix))) ?? null;
}

export const isRouter = (thread: Pick<BridgeThread, "tags">) => thread.tags.includes(ROUTER_TAG);

/** A proposal waits for the user's approval in T3: it plans, and does nothing else. */
export const isProposal = (thread: Pick<BridgeThread, "tags" | "interactionMode">) =>
  thread.tags.includes(PROPOSAL_TAG) || thread.interactionMode === "plan";

/**
 * The task a channel message answers: the user's reply in the conversation exactly one task came
 * from. Anything else goes to the router, which also decides when one conversation fed several
 * tasks.
 */
export function taskForMessage(
  message: ChannelMessage,
  threads: Iterable<BridgeThread>,
  prefixes: ReadonlyArray<string>,
): BridgeThread | null {
  if (!message.fromUser) return null;
  let match: BridgeThread | null = null;
  for (const thread of threads) {
    if (thread.archived || isRouter(thread) || originOf(thread, prefixes) !== message.ref) continue;
    if (match !== null) return null;
    match = thread;
  }
  return match;
}

/**
 * The conversation super-t3 may post in about a task: where the user asked for it. A task proposed
 * from someone else's message never posts in their thread. The router answers in channels itself.
 */
export function announceTarget(
  thread: BridgeThread,
  prefixes: ReadonlyArray<string>,
): string | null {
  if (thread.archived || isRouter(thread) || !thread.tags.includes(FROM_USER_TAG)) return null;
  return originOf(thread, prefixes);
}

/** Where a task's runs are reported: where the user asked for it, once they approved it. */
export function reportTarget(thread: BridgeThread, prefixes: ReadonlyArray<string>): string | null {
  return isProposal(thread) ? null : announceTarget(thread, prefixes);
}

export function proposalNote(title: string): string {
  return `Proposed in T3: ${title}. It starts when you approve it there.`;
}

export const progressSteps = (
  steps: ReadonlyArray<OrchestrationV2PlanStep>,
): ReadonlyArray<ProgressStep> =>
  steps.map((step) => ({ id: step.id, text: step.text, status: step.status }));
