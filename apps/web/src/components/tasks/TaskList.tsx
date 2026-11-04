import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
import {
  TaskColumnGlyph,
  TaskProjectLabel,
  TaskStatusPill,
  TaskSubtaskCount,
  TaskUpdatedAt,
} from "./TaskPresentation";
import { TASK_COLUMN_LABELS, type TaskColumn, type TaskNode } from "./tasks.logic";

export function TaskList({
  columns,
  projectOf,
  onOpen,
}: {
  columns: ReadonlyArray<{ column: TaskColumn; tasks: ReadonlyArray<TaskNode> }>;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  onOpen: (task: TaskNode) => void;
}) {
  return (
    <div className="space-y-4">
      {columns
        .filter(({ tasks }) => tasks.length > 0)
        .map(({ column, tasks }) => (
          <section key={column} aria-label={TASK_COLUMN_LABELS[column]} className="space-y-0.5">
            <header className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
              <TaskColumnGlyph column={column} />
              <h2 className="shrink-0">{TASK_COLUMN_LABELS[column]}</h2>
              <span className="shrink-0 tabular-nums text-muted-foreground/50">{tasks.length}</span>
              <Separator className="min-w-2 flex-1" />
            </header>
            {tasks.map((task) => (
              <TaskRow key={task.key} task={task} depth={0} projectOf={projectOf} onOpen={onOpen} />
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
  onOpen,
}: {
  task: TaskNode;
  depth: number;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  onOpen: (task: TaskNode) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasSubtasks = task.subtasks.length > 0;
  return (
    <>
      <div
        className={cn(
          "group/task-row flex w-full items-center gap-2 rounded-md py-1.5 pr-3 hover:bg-accent/50",
          task.column === "done" && depth === 0 && "opacity-70",
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
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-hidden"
        >
          <TaskColumnGlyph column={task.column} />
          <span className="min-w-0 truncate text-sm">{task.thread.title}</span>
          <TaskSubtaskCount task={task} />
          <span className="ml-auto flex shrink-0 items-center gap-3">
            <TaskStatusPill task={task} />
            {depth === 0 ? <TaskProjectLabel project={projectOf(task)} /> : null}
            <TaskUpdatedAt task={task} />
          </span>
        </button>
      </div>
      {expanded
        ? task.subtasks.map((subtask) => (
            <TaskRow
              key={subtask.key}
              task={subtask}
              depth={depth + 1}
              projectOf={projectOf}
              onOpen={onOpen}
            />
          ))
        : null}
    </>
  );
}
