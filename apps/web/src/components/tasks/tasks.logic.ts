import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import {
  isProviderNativeSubagentThread,
  PROPOSAL_TAG,
  ROUTER_TAG,
  SLACK_ORIGIN_TAG_PREFIX,
} from "@t3tools/contracts";

import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/**
 * What a task is waiting on. A thread is a task and the threads it delegates to are subtasks.
 * Proposed waits for the user's approval of its plan. Needs you covers approvals, questions,
 * guest requests, failures and usage limits. Ready for review is finished work the user has not
 * settled yet. Done is settled, the way T3's sidebar hides threads that no longer need you.
 */
export const TASK_STATUSES = [
  "proposed",
  "needs_you",
  "review",
  "working",
  "done",
  "snoozed",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  proposed: "Proposed",
  needs_you: "Needs you",
  review: "Ready for review",
  working: "Working",
  done: "Done",
  snoozed: "Snoozed",
};

/**
 * The board's columns. Everything waiting on the user shares one column, most urgent first, with
 * running work at its foot; done and snoozed tasks stay hidden until the user asks for them.
 */
export const BOARD_COLUMNS = [
  { id: "proposed", label: "Proposed", statuses: ["proposed"] },
  { id: "now", label: "Needs you", statuses: ["needs_you", "review", "working"] },
  { id: "done", label: "Done", statuses: ["done", "snoozed"] },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly statuses: ReadonlyArray<TaskStatus>;
}>;
export type BoardColumnId = (typeof BOARD_COLUMNS)[number]["id"];

export interface TaskNode {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly status: TaskStatus;
  readonly subtasks: ReadonlyArray<TaskNode>;
}

function taskKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

export function isRouterThread(thread: Pick<EnvironmentThreadShell, "source">): boolean {
  return thread.source.tags?.includes(ROUTER_TAG) === true;
}

/** A task the router proposed, until the user approves it, or one the user moved back to Proposed. */
function isProposal(thread: Pick<EnvironmentThreadShell, "source" | "interactionMode">) {
  return thread.source.tags?.includes(PROPOSAL_TAG) === true || thread.interactionMode === "plan";
}

/** The Slack message a proposal came from, as `slack:<channel>:<thread ts>`. */
export function slackOriginOf(thread: Pick<EnvironmentThreadShell, "source">): string | null {
  return thread.source.tags?.find((tag) => tag.startsWith(SLACK_ORIGIN_TAG_PREFIX)) ?? null;
}

const ACTIVE_RUNTIME = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function resolveTaskStatus(thread: EnvironmentThreadShell, now: string): TaskStatus {
  if (thread.settledOverride === "settled") return "done";
  if (effectiveSnoozed(thread, { now })) return "snoozed";
  const status = resolveSidebarThreadStatus(thread);
  if (
    status === "approval" ||
    status === "input" ||
    status === "request" ||
    status === "failed" ||
    status === "limited"
  ) {
    return "needs_you";
  }
  if (isProposal(thread)) return "proposed";
  if (
    (thread.runtime !== null && ACTIVE_RUNTIME.has(thread.runtime.status)) ||
    thread.pendingBackgroundTasks.length > 0
  ) {
    return "working";
  }
  return "review";
}

/** Subtasks are the threads a task delegated work to. Provider-native subagents and side chats stay inside their thread. */
function isSubtask(thread: EnvironmentThreadShell): boolean {
  return (
    thread.lineage.relationshipToParent === "subagent" &&
    thread.lineage.parentThreadId !== null &&
    !isProviderNativeSubagentThread(thread.source)
  );
}

function isHiddenChild(thread: EnvironmentThreadShell): boolean {
  return (
    thread.lineage.sideChat === true ||
    (thread.lineage.relationshipToParent === "subagent" && !isSubtask(thread))
  );
}

/**
 * Builds the task tree from every thread shell. The router is left out, and the work it delegates
 * becomes top-level tasks, since the router only hands work out. A subtask whose parent is missing
 * becomes a task, so its work is never out of reach.
 */
export function buildTaskTree(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  now: string,
): ReadonlyArray<TaskNode> {
  const live = threads.filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null && !isHiddenChild(thread),
  );
  const routerKeys = new Set(live.filter(isRouterThread).map(taskKey));
  const byKey = new Map(live.map((thread) => [taskKey(thread), thread]));
  const childrenByParent = new Map<string, EnvironmentThreadShell[]>();
  const roots: EnvironmentThreadShell[] = [];
  for (const thread of live) {
    const key = taskKey(thread);
    if (routerKeys.has(key)) continue;
    const parentKey =
      isSubtask(thread) && thread.lineage.parentThreadId !== null
        ? taskKey({ environmentId: thread.environmentId, id: thread.lineage.parentThreadId })
        : null;
    if (parentKey === null || !byKey.has(parentKey) || routerKeys.has(parentKey)) {
      roots.push(thread);
      continue;
    }
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(thread);
    childrenByParent.set(parentKey, siblings);
  }
  const build = (thread: EnvironmentThreadShell, seen: ReadonlySet<string>): TaskNode => {
    const key = taskKey(thread);
    const nextSeen = new Set(seen).add(key);
    return {
      key,
      thread,
      status: resolveTaskStatus(thread, now),
      subtasks: (childrenByParent.get(key) ?? [])
        .filter((child) => !nextSeen.has(taskKey(child)))
        .toSorted(byCreatedAt)
        .map((child) => build(child, nextSeen)),
    };
  };
  return roots.toSorted(byRecentActivity).map((thread) => build(thread, new Set()));
}

function byCreatedAt(a: EnvironmentThreadShell, b: EnvironmentThreadShell): number {
  return a.createdAt.localeCompare(b.createdAt);
}

function byRecentActivity(a: EnvironmentThreadShell, b: EnvironmentThreadShell): number {
  return b.updatedAt.localeCompare(a.updatedAt);
}

export function groupTasksByStatus(
  tasks: ReadonlyArray<TaskNode>,
): ReadonlyMap<TaskStatus, ReadonlyArray<TaskNode>> {
  const groups = new Map<TaskStatus, TaskNode[]>(TASK_STATUSES.map((status) => [status, []]));
  for (const task of tasks) groups.get(task.status)!.push(task);
  return groups;
}

export interface SubtaskProgress {
  readonly done: number;
  readonly total: number;
}

/** Counts every subtask below a task; done means settled or finished for review. */
export function subtaskProgress(task: TaskNode): SubtaskProgress {
  let done = 0;
  let total = 0;
  const visit = (node: TaskNode) => {
    for (const subtask of node.subtasks) {
      total += 1;
      if (subtask.status === "done" || subtask.status === "review") done += 1;
      visit(subtask);
    }
  };
  visit(task);
  return { done, total };
}

export function matchesTaskQuery(task: TaskNode, query: string): boolean {
  const folded = query.trim().toLowerCase();
  if (folded === "") return true;
  return (
    task.thread.title.toLowerCase().includes(folded) ||
    task.subtasks.some((subtask) => matchesTaskQuery(subtask, folded))
  );
}

/** The task with `key`, wherever it sits in the tree, and the task it belongs to. */
export function findTask(
  tasks: ReadonlyArray<TaskNode>,
  key: string,
): { readonly task: TaskNode; readonly parent: TaskNode | null } | null {
  const visit = (
    nodes: ReadonlyArray<TaskNode>,
    parent: TaskNode | null,
  ): { readonly task: TaskNode; readonly parent: TaskNode | null } | null => {
    for (const node of nodes) {
      if (node.key === key) return { task: node, parent };
      const found = visit(node.subtasks, node);
      if (found !== null) return found;
    }
    return null;
  };
  return visit(tasks, null);
}
