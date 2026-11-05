import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ChevronRightIcon } from "lucide-react";
import { useState, type DragEvent, type ReactNode } from "react";

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
  snoozed: "snoozed",
};

const EMPTY_TEXT: Record<BoardColumnId, string> = {
  proposed: "Nothing to approve. The router proposes work here.",
  now: "Nothing needs you right now.",
  done: "Nothing done yet.",
  snoozed: "Nothing snoozed.",
};

export function TaskBoard({
  columns,
  hiddenColumns,
  projectOf,
  actions,
  selectedKey,
  onOpen,
}: {
  columns: ReadonlyArray<BoardColumn>;
  hiddenColumns: ReadonlyArray<BoardColumn>;
  projectOf: (task: TaskNode) => EnvironmentProject | undefined;
  actions: TaskActions;
  selectedKey: string | null;
  onOpen: (task: TaskNode) => void;
}) {
  const [workingOpen, setWorkingOpen] = useState(true);
  const [hiddenOpen, setHiddenOpen] = useState(true);
  const [openHidden, setOpenHidden] = useState<BoardColumnId | null>(null);
  const findTask = (key: string) =>
    [...columns, ...hiddenColumns].flatMap((entry) => entry.tasks).find((task) => task.key === key);
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
    else if (column === "now" && task.status === "done") void actions.unsettle(task);
  };
  const dropTarget = (column: BoardColumnId) => ({
    onDragOver: (event: DragEvent) => {
      if (event.dataTransfer.types.includes(TASK_DRAG_TYPE)) event.preventDefault();
    },
    onDrop: (event: DragEvent) => {
      const task = findTask(event.dataTransfer.getData(TASK_DRAG_TYPE));
      if (task !== undefined) drop(task, column);
    },
  });
  return (
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto px-4 pb-4 sm:px-6">
      {columns.map(({ id, label, tasks }) => {
        const urgent = id === "now" ? tasks.filter((task) => task.status !== "working") : tasks;
        const working = id === "now" ? tasks.filter((task) => task.status === "working") : [];
        return (
          <section
            key={id}
            aria-label={label}
            className="flex w-72 shrink-0 flex-col gap-2 xl:w-80"
            {...dropTarget(id)}
          >
            <header className="flex h-7 items-center gap-2 px-1.5 text-xs font-medium">
              <TaskStatusGlyph status={COLUMN_GLYPH[id]} />
              <h2 className="text-foreground">{label}</h2>
              <span className="tabular-nums text-muted-foreground/60">{urgent.length}</span>
            </header>
            {/* The router's composer floats over the bottom; the last card can scroll above it. */}
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-xl bg-muted/30 p-2 pb-(--router-dock-space)">
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
      {/* Like Linear, columns that do not need the user wait at the side, one click away. */}
      <aside
        aria-label="Hidden columns"
        className="ml-auto flex w-72 shrink-0 flex-col gap-2 xl:w-80"
      >
        <button
          type="button"
          aria-expanded={hiddenOpen}
          onClick={() => setHiddenOpen(!hiddenOpen)}
          className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs font-medium text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", hiddenOpen && "rotate-90")}
          />
          Hidden columns
        </button>
        {hiddenOpen ? (
          <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pb-(--router-dock-space)">
            {hiddenColumns.map(({ id, label, tasks }) => {
              const open = openHidden === id;
              return (
                <section
                  key={id}
                  aria-label={label}
                  className={cn(
                    "flex shrink-0 flex-col rounded-lg border border-border/70 bg-muted/30",
                    open && "min-h-0 shrink",
                  )}
                  {...dropTarget(id)}
                >
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenHidden(open ? null : id)}
                    className="flex h-10 shrink-0 items-center gap-2.5 rounded-lg px-3 text-sm outline-hidden hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <TaskStatusGlyph status={COLUMN_GLYPH[id]} className="size-4" />
                    <h2 className="font-medium text-foreground">{label}</h2>
                    <span className="ml-auto tabular-nums text-muted-foreground">
                      {tasks.length}
                    </span>
                  </button>
                  {open ? (
                    <div className="flex min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5 pt-0">
                      {tasks.length === 0 ? (
                        <p className="px-2 py-2 text-xs text-muted-foreground/70">
                          {EMPTY_TEXT[id]}
                        </p>
                      ) : (
                        tasks.map(card)
                      )}
                    </div>
                  ) : null}
                </section>
              );
            })}
          </div>
        ) : null}
      </aside>
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
        "group/task relative flex min-h-28 w-full shrink-0 flex-col justify-between gap-2 rounded-lg border border-border/70 bg-card p-3 text-left shadow-xs/5",
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
        className="absolute inset-0 rounded-lg outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
      />
      <span className="pointer-events-none flex min-w-0 flex-col gap-2">
        <span className="flex min-w-0 items-start gap-2">
          <TaskStatusGlyph status={task.status} className="mt-0.5" />
          <TaskTitle
            task={task}
            actions={actions}
            className="line-clamp-2 min-w-0 flex-1 text-sm leading-snug"
          />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 pl-5.5">
          <TaskStatusPill task={task} />
          <TaskSubtaskCount task={task} />
          <TaskBranchLabel task={task} />
          <TaskSlackOrigin task={task} />
        </span>
      </span>
      <span className="pointer-events-none flex min-h-6 min-w-0 items-center gap-2 pl-5.5">
        <TaskProjectLabel project={project} />
        <TaskPinnedMark task={task} />
        <span className="ml-auto">
          {canApproveTask(task) ? (
            <span className="pointer-events-auto relative z-10">
              <TaskApproveButton task={task} />
            </span>
          ) : (
            <TaskUpdatedAt task={task} />
          )}
        </span>
      </span>
      <TaskQuickActions
        task={task}
        actions={actions}
        className="absolute top-1.5 right-1.5 rounded-md bg-card shadow-xs/5"
      />
    </div>
  );
}
