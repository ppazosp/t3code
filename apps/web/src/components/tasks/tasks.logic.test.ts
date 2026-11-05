import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildTaskTree, resolveTaskStatus, subtaskProgress, type TaskNode } from "./tasks.logic";

const NOW = "2026-11-04T12:00:00.000Z";
const environmentId = EnvironmentId.make("env");

function shell(
  id: string,
  overrides: Partial<Omit<EnvironmentThreadShell, "source">> & {
    readonly parent?: string;
    readonly relationship?: "subagent" | "fork";
    readonly sideChat?: boolean;
    readonly creationSource?: "web" | "mcp" | "provider";
    readonly tags?: ReadonlyArray<string>;
  } = {},
): EnvironmentThreadShell {
  const { parent, relationship, sideChat, creationSource, tags, ...fields } = overrides;
  const lineage = {
    parentThreadId: parent === undefined ? null : ThreadId.make(parent),
    relationshipToParent: parent === undefined ? null : (relationship ?? "subagent"),
    rootThreadId: ThreadId.make(parent ?? id),
    ...(sideChat === undefined ? {} : { sideChat }),
  };
  return {
    environmentId,
    id: ThreadId.make(id),
    title: id,
    interactionMode: "default",
    lineage,
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    createdAt: "2026-11-04T10:00:00.000Z",
    updatedAt: "2026-11-04T10:00:00.000Z",
    ...fields,
    source: { lineage, creationSource: creationSource ?? "mcp", tags: tags ?? [] },
  } as unknown as EnvironmentThreadShell;
}

const running = { status: "running", activeRunId: "run", updatedAt: NOW } as never;
const completed = { status: "completed", activeRunId: null, updatedAt: NOW } as never;
const finishedRun = { status: "completed", completedAt: NOW } as never;

describe("resolveTaskStatus", () => {
  it.each([
    ["review", shell("a")],
    ["working", shell("a", { runtime: running })],
    ["review", shell("a", { runtime: completed, latestRun: finishedRun })],
    ["needs_you", shell("a", { runtime: running, hasPendingApprovals: true })],
    ["proposed", shell("a", { interactionMode: "plan", runtime: running })],
    ["needs_you", shell("a", { interactionMode: "plan", hasPendingUserInput: true })],
    // A proposal stays proposed after the user chats with it, until Approve removes the tag.
    ["proposed", shell("a", { tags: ["proposal"], runtime: completed, latestRun: finishedRun })],
    ["done", shell("a", { settledOverride: "settled", runtime: running })],
    ["snoozed", shell("a", { snoozedUntil: "2026-11-05T00:00:00.000Z" })],
  ] as const)("puts the thread in %s", (status, thread) => {
    expect(resolveTaskStatus(thread, NOW)).toBe(status);
  });
});

describe("buildTaskTree", () => {
  const keys = (tasks: ReadonlyArray<TaskNode>): unknown =>
    tasks.map((task) =>
      task.subtasks.length === 0 ? task.thread.id : [task.thread.id, keys(task.subtasks)],
    );

  it("nests delegated threads under their task and leaves the router out", () => {
    const tasks = buildTaskTree(
      [
        shell("router", { tags: ["router"] }),
        shell("launched-by-router", { parent: "router" }),
        shell("task"),
        shell("child", { parent: "task" }),
        shell("grandchild", { parent: "child" }),
        shell("native", { parent: "task", creationSource: "provider" }),
        shell("side", { parent: "task", relationship: "fork", sideChat: true }),
        shell("fork", { parent: "task", relationship: "fork" }),
        shell("orphan", { parent: "missing" }),
        shell("archived", { archivedAt: NOW }),
      ],
      NOW,
    );
    expect(keys(tasks)).toEqual([
      "launched-by-router",
      ["task", [["child", ["grandchild"]]]],
      "fork",
      "orphan",
    ]);
  });

  it("counts finished subtasks at every depth", () => {
    const [task] = buildTaskTree(
      [
        shell("task"),
        shell("child", { parent: "task", settledOverride: "settled" }),
        shell("grandchild", { parent: "child", runtime: running }),
      ],
      NOW,
    );
    expect(subtaskProgress(task!)).toEqual({ done: 1, total: 2 });
  });
});
