import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { canApproveTask, TaskApproveButton } from "./TaskApproveButton";
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
import type { BoardColumnId, TaskNode, TaskStatus } from "./tasks.logic";
import type { TaskActions } from "./useTaskActions";

export interface BoardColumn {
  readonly id: BoardColumnId;
  readonly label: string;
  readonly tasks: ReadonlyArray<TaskNode>;
}

const COLUMN_GLYPH: Record<BoardColumnId, TaskStatus> = {
  proposed: "proposed",
  now: "needs_you",
  done: "done",
};

const EMPTY_TEXT: Record<BoardColumnId, string> = {
  proposed: "Nothing to approve. The router proposes work here.",
  now: "Nothing needs you right now.",
  done: "Nothing done yet.",
};

export function TaskBoard({
  columns,
  projectOf,
  actions,
  selectedKey,
  onOpen,
}: {
  columns: ReadonlyArray<BoardColumn>;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  actions: TaskActions;
  selectedKey: string | null;
  onOpen: (task: TaskNode) => void;
}) {
  const [workingOpen, setWorkingOpen] = useState(true);
  const findTask = (key: string) =>
    columns.flatMap((entry) => entry.tasks).find((task) => task.key === key);
  const card = (task: TaskNode) => (
    <TaskCard
      key={task.key}
      task={task}
      project={projectOf(task)}
      actions={actions}
      selected={task.key === selectedKey}
      onOpen={() => onOpen(task)}
    />
  );
  // Dropping a card asks for what that column stands for, where that is the user's call.
  const drop = (task: TaskNode, column: BoardColumnId) => {
    if (column === "proposed" || column === "done") void actions.moveTask(task, column);
    else if (task.status === "done") void actions.unsettle(task);
  };
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 sm:px-6">
      {columns.map(({ id, label, tasks }) => {
        const urgent = id === "now" ? tasks.filter((task) => task.status !== "working") : tasks;
        const working = id === "now" ? tasks.filter((task) => task.status === "working") : [];
        return (
          <section
            key={id}
            aria-label={label}
            className="flex w-80 shrink-0 flex-col gap-2 xl:w-96"
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
            }}
            onDrop={(event) => {
              const task = findTask(event.dataTransfer.getData(TASK_DRAG_TYPE));
              if (task !== undefined) drop(task, id);
            }}
          >
            <header className="flex h-7 items-center gap-2 px-1.5 text-xs font-medium">
              <TaskStatusGlyph status={COLUMN_GLYPH[id]} />
              <h2 className="text-foreground">{label}</h2>
              <span className="tabular-nums text-muted-foreground/60">{urgent.length}</span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto rounded-xl bg-muted/30 p-1.5">
              {urgent.length === 0 ? (
                <p className="px-2 py-3 text-xs text-muted-foreground/70">{EMPTY_TEXT[id]}</p>
              ) : (
                urgent.map(card)
              )}
              {working.length === 0 ? null : (
                <WorkingSection
                  count={working.length}
                  open={workingOpen}
                  onToggle={() => setWorkingOpen(!workingOpen)}
                >
                  {working.map(card)}
                </WorkingSection>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Running work sits under what needs the user, quieter, and folds away. */
function WorkingSection({
  count,
  open,
  onToggle,
  children,
}: {
  count: number;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mt-2 flex flex-col gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex h-7 items-center gap-2 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        <TaskStatusGlyph status="working" />
        Working
        <span className="tabular-nums text-muted-foreground/60">{count}</span>
      </button>
      {open ? <div className="flex flex-col gap-1.5 opacity-80">{children}</div> : null}
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
        task.status === "done" && "opacity-70",
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
        <TaskStatusGlyph status={task.status} className="mt-0.5" />
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
