import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { cn } from "~/lib/utils";
import {
  TaskColumnGlyph,
  TaskProjectLabel,
  TaskStatusPill,
  TaskSubtaskCount,
  TaskUpdatedAt,
} from "./TaskPresentation";
import { TASK_COLUMN_LABELS, type TaskColumn, type TaskNode } from "./tasks.logic";

export function TaskBoard({
  columns,
  projectOf,
  onOpen,
  onDropInColumn,
}: {
  columns: ReadonlyArray<{ column: TaskColumn; tasks: ReadonlyArray<TaskNode> }>;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  onOpen: (task: TaskNode) => void;
  /** Dropping a card moves it to the column, when the column has a way in. */
  onDropInColumn: (task: TaskNode, column: TaskColumn) => void;
}) {
  const findTask = (key: string) =>
    columns.flatMap((entry) => entry.tasks).find((task) => task.key === key);
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-5 pb-6 sm:px-6">
      {columns.map(({ column, tasks }) => (
        <section
          key={column}
          aria-label={TASK_COLUMN_LABELS[column]}
          className="flex w-72 shrink-0 flex-col gap-2"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
          }}
          onDrop={(event) => {
            const task = findTask(event.dataTransfer.getData(TASK_DRAG_TYPE));
            if (task !== undefined && task.column !== column) onDropInColumn(task, column);
          }}
        >
          <header className="flex items-center gap-2 px-1 text-xs font-medium text-muted-foreground">
            <TaskColumnGlyph column={column} />
            <h2 className="text-foreground">{TASK_COLUMN_LABELS[column]}</h2>
            <span className="tabular-nums text-muted-foreground/60">{tasks.length}</span>
          </header>
          <div className="flex min-h-24 flex-col gap-1.5 overflow-y-auto rounded-lg bg-muted/30 p-1.5">
            {tasks.map((task) => (
              <TaskCard
                key={task.key}
                task={task}
                project={projectOf(task)}
                onOpen={() => onOpen(task)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const TASK_DRAG_TYPE = "application/x-t3-task";

function TaskCard({
  task,
  project,
  onOpen,
}: {
  task: TaskNode;
  project: EnvironmentProject | undefined;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TASK_DRAG_TYPE, task.key);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={onOpen}
      className={cn(
        "flex w-full flex-col gap-2 rounded-md border border-border/70 bg-card p-2.5 text-left shadow-xs/5",
        "outline-hidden ring-ring hover:border-border hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset",
        task.column === "done" && "opacity-70",
      )}
    >
      <span className="flex min-w-0 items-start gap-2">
        <TaskColumnGlyph column={task.column} className="mt-0.5" />
        <span className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug">
          {task.thread.title}
        </span>
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
        <TaskStatusPill task={task} />
        <TaskSubtaskCount task={task} />
        <TaskProjectLabel project={project} />
        <span className="ml-auto">
          <TaskUpdatedAt task={task} />
        </span>
      </span>
    </button>
  );
}
