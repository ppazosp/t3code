import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { canApproveTask, TaskApproveButton } from "./TaskApproveButton";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import {
  TaskBranchLabel,
  TaskStatusGlyph,
  TaskPinnedMark,
  TaskProjectLabel,
  TaskQuickActions,
  TaskSlackOrigin,
  TaskStatusPill,
  TaskSubtaskCount,
  TaskTitle,
  TaskUpdatedAt,
} from "./TaskPresentation";
import { HIDDEN_STATUSES, TASK_STATUS_LABELS, type TaskStatus, type TaskNode } from "./tasks.logic";
import type { TaskActions } from "./useTaskActions";

export function TaskList({
  sections,
  onToggleFolded,
  projectOf,
  actions,
  selectedKey,
  onOpen,
}: {
  sections: ReadonlyArray<{ status: TaskStatus; tasks: ReadonlyArray<TaskNode>; folded: boolean }>;
  onToggleFolded: (status: TaskStatus) => void;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  actions: TaskActions;
  selectedKey: string | null;
  onOpen: (task: TaskNode) => void;
}) {
  return (
    <div className="space-y-4">
      {sections
        .filter(({ tasks }) => tasks.length > 0)
        .map(({ status, tasks, folded }) => (
          <section key={status} aria-label={TASK_STATUS_LABELS[status]} className="space-y-0.5">
            <header className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
              {HIDDEN_STATUSES.has(status) ? (
                <button
                  type="button"
                  aria-expanded={!folded}
                  aria-label={`${folded ? "Show" : "Hide"} ${TASK_STATUS_LABELS[status]}`}
                  onClick={() => onToggleFolded(status)}
                  className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <ChevronRightIcon
                    className={cn("size-3.5 transition-transform", !folded && "rotate-90")}
                  />
                </button>
              ) : null}
              <TaskStatusGlyph status={status} />
              <h2 className="shrink-0">{TASK_STATUS_LABELS[status]}</h2>
              <span className="shrink-0 tabular-nums text-muted-foreground/50">{tasks.length}</span>
              <Separator className="min-w-2 flex-1" />
            </header>
            {(folded ? [] : tasks).map((task) => (
              <TaskRow
                key={task.key}
                task={task}
                depth={0}
                projectOf={projectOf}
                actions={actions}
                selectedKey={selectedKey}
                onOpen={onOpen}
              />
            ))}
          </section>
        ))}
    </div>
  );
}

function TaskRow({
  task,
  depth,
  projectOf,
  actions,
  selectedKey,
  onOpen,
}: {
  task: TaskNode;
  depth: number;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  actions: TaskActions;
  selectedKey: string | null;
  onOpen: (task: TaskNode) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasSubtasks = task.subtasks.length > 0;
  return (
    <>
      <div
        data-task-key={task.key}
        onContextMenu={(event) => {
          event.preventDefault();
          void actions.openMenu(task, { x: event.clientX, y: event.clientY });
        }}
        className={cn(
          "group/task flex w-full items-center gap-2 rounded-md py-1 pr-2 hover:bg-accent/50",
          task.key === selectedKey && "bg-accent/60",
          task.status === "done" && depth === 0 && "opacity-70",
        )}
        style={{ paddingLeft: `${0.75 + depth * 1.25}rem` }}
      >
        <button
          type="button"
          aria-label={expanded ? "Hide subtasks" : "Show subtasks"}
          aria-expanded={expanded}
          disabled={!hasSubtasks}
          onClick={() => setExpanded(!expanded)}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground disabled:invisible"
        >
          <ChevronRightIcon
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
          />
        </button>
        <button
          type="button"
          onClick={() => onOpen(task)}
          className="flex min-w-0 flex-1 items-center gap-2 py-0.5 text-left outline-hidden"
        >
          <TaskStatusGlyph status={task.status} />
          <TaskTitle task={task} actions={actions} className="min-w-0 truncate text-sm" />
          <TaskSubtaskCount task={task} />
          <TaskPinnedMark task={task} />
          <TaskSlackOrigin task={task} />
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <TaskStatusPill task={task} />
            <span className="hidden max-w-48 md:flex">
              <TaskBranchLabel task={task} />
            </span>
            {depth === 0 ? <TaskProjectLabel project={projectOf(task)} /> : null}
            <TaskUpdatedAt task={task} />
          </span>
        </button>
        {canApproveTask(task) ? (
          <>
            <Button size="xs" variant="outline" onClick={() => void actions.discard(task)}>
              Discard
            </Button>
            <TaskApproveButton task={task} />
          </>
        ) : null}
        <TaskQuickActions task={task} actions={actions} />
      </div>
      {expanded
        ? task.subtasks.map((subtask) => (
            <TaskRow
              key={subtask.key}
              task={subtask}
              depth={depth + 1}
              projectOf={projectOf}
              actions={actions}
              selectedKey={selectedKey}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}
