import { FROM_USER_TAG, ROUTER_TAG, type OrchestrationV2PlanStep } from "@t3tools/contracts";

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

/** The live tasks that came from the conversation `ref` names. */
export function tasksFrom(
  ref: string,
  threads: Iterable<BridgeThread>,
  prefixes: ReadonlyArray<string>,
): ReadonlyArray<BridgeThread> {
  return [...threads].filter(
    (thread) => !thread.archived && !isRouter(thread) && originOf(thread, prefixes) === ref,
  );
}

/**
 * The task a channel message answers: the user's own request (a DM, or a mention in a channel) in
 * the conversation exactly one task came from. Anything else goes to the router, which also decides
 * when one conversation fed several tasks.
 */
export function taskForMessage(
  message: ChannelMessage,
  threads: Iterable<BridgeThread>,
  prefixes: ReadonlyArray<string>,
): BridgeThread | null {
  if (!message.fromUser || !message.direct) return null;
  const tasks = tasksFrom(message.ref, threads, prefixes);
  return tasks.length === 1 ? tasks[0]! : null;
}

/** The user's request that is only "stop": it stops the conversation's tasks, without the router. */
export function isStop(message: ChannelMessage): boolean {
  return message.fromUser && message.direct && /^stop[.!]*$/iu.test(message.text.trim());
}

/**
 * Where a worker reports: the conversation the user asked for it in. Work proposed from someone
 * else's message never posts in their thread. The router answers in channels itself.
 */
export function reportTarget(thread: BridgeThread, prefixes: ReadonlyArray<string>): string | null {
  if (thread.archived || isRouter(thread) || !thread.tags.includes(FROM_USER_TAG)) return null;
  return originOf(thread, prefixes);
}

export function proposalNote(title: string): string {
  return `Proposed in super-t3: ${title}. It starts when you accept it there.`;
}

export const progressSteps = (
  steps: ReadonlyArray<OrchestrationV2PlanStep>,
): ReadonlyArray<ProgressStep> =>
  steps.map((step) => ({ id: step.id, text: step.text, status: step.status }));

/**
 * The router's message: a header it is told how to read, then the text quoted line by line, so a
 * line that looks like a header inside someone's message cannot pass for one.
 */
export function routerMessageText(channel: string, message: ChannelMessage): string {
  return `[${channel} ${message.where} from ${message.author} ref=${message.ref}]\n${quote(message.text)}`;
}

/** What a task gets when the user writes in its conversation, and how to answer there. */
export function taskMessageText(channel: string, text: string): string {
  return `The user wrote in your ${channelLabel(channel)} thread:\n${quote(text)}\n\nAnswer briefly there with channel_say, then carry on.`;
}

/** What a task gets when the user asks, in its conversation, for changes to its plan. */
export function planChangeText(channel: string, text: string): string {
  return `The user asked for changes to your plan in ${channelLabel(channel)}:\n${quote(text)}\n\nRevise the plan.`;
}

const channelLabel = (channel: string) => channel.charAt(0).toUpperCase() + channel.slice(1);

const quote = (text: string) =>
  text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
