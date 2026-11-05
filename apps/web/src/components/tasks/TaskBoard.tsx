import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";

import { cn } from "~/lib/utils";
import { canApproveTask, TaskApproveButton } from "./TaskApproveButton";
import {
  TaskBranchLabel,
  TaskColumnGlyph,
  TaskPinnedMark,
  TaskProjectLabel,
  TaskQuickActions,
  TaskSlackOrigin,
  TaskStatusPill,
  TaskSubtaskCount,
  TaskTitle,
  TaskUpdatedAt,
} from "./TaskPresentation";
import { TASK_COLUMN_LABELS, type TaskColumn, type TaskNode } from "./tasks.logic";
import type { TaskActions } from "./useTaskActions";

export function TaskBoard({
  columns,
  projectOf,
  actions,
  selectedKey,
  onOpen,
}: {
  columns: ReadonlyArray<{ column: TaskColumn; tasks: ReadonlyArray<TaskNode> }>;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  actions: TaskActions;
  selectedKey: string | null;
  onOpen: (task: TaskNode) => void;
}) {
  const findTask = (key: string) =>
    columns.flatMap((entry) => entry.tasks).find((task) => task.key === key);
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto px-4 pb-4 sm:px-6">
      {columns.map(({ column, tasks }) => (
        <section
          key={column}
          aria-label={TASK_COLUMN_LABELS[column]}
          className="flex min-w-56 flex-1 basis-0 flex-col gap-2"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
          }}
          onDrop={(event) => {
            const task = findTask(event.dataTransfer.getData(TASK_DRAG_TYPE));
            if (task !== undefined) void actions.moveTask(task, column);
          }}
        >
          <header className="flex h-7 items-center gap-2 px-1.5 text-xs font-medium">
            <TaskColumnGlyph column={column} />
            <h2 className="text-foreground">{TASK_COLUMN_LABELS[column]}</h2>
            <span className="tabular-nums text-muted-foreground/60">{tasks.length}</span>
          </header>
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-lg bg-muted/30 p-1.5">
            {tasks.map((task) => (
              <TaskCard
                key={task.key}
                task={task}
                project={projectOf(task)}
                actions={actions}
                selected={task.key === selectedKey}
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
  actions,
  selected,
  onOpen,
}: {
  task: TaskNode;
  project: EnvironmentProject | undefined;
  actions: TaskActions;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      draggable
      data-task-key={task.key}
      onDragStart={(event) => {
        event.dataTransfer.setData(TASK_DRAG_TYPE, task.key);
        event.dataTransfer.effectAllowed = "move";
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        void actions.openMenu(task, { x: event.clientX, y: event.clientY });
      }}
      className={cn(
        "group/task relative flex w-full flex-col gap-1.5 rounded-md border border-border/70 bg-card px-2.5 py-2 text-left shadow-xs/5",
        "hover:border-border hover:bg-accent/40",
        selected && "border-ring/60 ring-1 ring-ring/40",
        task.column === "done" && "opacity-70",
      )}
    >
      {/* The whole card opens the task; its own controls sit above this layer. */}
      <button
        type="button"
        aria-label={`Open ${task.thread.title}`}
        onClick={onOpen}
        className="absolute inset-0 rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
      />
      <span className="pointer-events-none flex min-w-0 items-start gap-2">
        <TaskColumnGlyph column={task.column} className="mt-0.5" />
        <TaskTitle
          task={task}
          actions={actions}
          className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug"
        />
      </span>
      <TaskQuickActions
        task={task}
        actions={actions}
        className="absolute top-1 right-1 rounded-md bg-card shadow-xs/5"
      />
      <span className="pointer-events-none flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-5.5">
        <TaskStatusPill task={task} />
        <TaskSubtaskCount task={task} />
        <TaskBranchLabel task={task} />
        <TaskSlackOrigin task={task} />
      </span>
      <span className="pointer-events-none flex min-w-0 items-center gap-2 pl-5.5">
        <TaskProjectLabel project={project} />
        <TaskPinnedMark task={task} />
        <span className="ml-auto">
          <TaskUpdatedAt task={task} />
        </span>
      </span>
      {canApproveTask(task) ? (
        <span className="relative z-10 flex justify-end">
          <TaskApproveButton task={task} />
        </span>
      ) : null}
    </div>
  );
}
