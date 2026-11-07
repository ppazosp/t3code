import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  ClockIcon,
  EllipsisIcon,
  GitBranchIcon,
  LightbulbIcon,
  type LucideIcon,
  PinIcon,
  RotateCcwIcon,
} from "lucide-react";
import type { MouseEvent, ReactNode } from "react";

import { cn } from "~/lib/utils";
import { MiddleTruncate } from "../ui/middle-truncate";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RelativeTime } from "../RelativeTime";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { SlackIcon } from "../Icons";
import { useTaskModel } from "./useTaskModel";
import {
  slackOriginOf,
  subtaskProgress,
  TASK_STATUS_LABELS,
  type TaskStatus,
  type TaskNode,
} from "./tasks.logic";
import type { TaskActions } from "./useTaskActions";

const STATUS_GLYPHS: Record<TaskStatus, { Icon: LucideIcon; className: string }> = {
  proposed: { Icon: LightbulbIcon, className: "text-primary" },
  needs_you: { Icon: CircleAlertIcon, className: "text-warning" },
  // Finished work waiting for review needs the user too, so it shares the Needs you column's icon.
  review: { Icon: CircleAlertIcon, className: "text-warning" },
  working: { Icon: CircleDotIcon, className: "text-info" },
  done: { Icon: CircleCheckIcon, className: "text-muted-foreground" },
  snoozed: { Icon: AlarmClockIcon, className: "text-muted-foreground" },
};

export function TaskStatusGlyph({ status, className }: { status: TaskStatus; className?: string }) {
  const { Icon, className: colorClass } = STATUS_GLYPHS[status];
  return (
    <Icon
      aria-label={TASK_STATUS_LABELS[status]}
      className={cn("size-3.5 shrink-0", colorClass, className)}
    />
  );
}

/**
 * The thread's own status pill, the same one the sidebar shows, only when it says why a task needs
 * the user. Elsewhere it repeats what the column already says.
 */
export function TaskStatusPill({ task }: { task: TaskNode }) {
  const pill =
    task.status === "needs_you" ? resolveThreadStatusPill({ thread: task.thread }) : null;
  if (pill === null) return null;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-2xs", pill.colorClass)}>
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full", pill.dotClass, pill.pulse && "animate-pulse")}
      />
      {pill.label}
    </span>
  );
}

export function TaskSubtaskCount({ task }: { task: TaskNode }) {
  const { done, total } = subtaskProgress(task);
  if (total === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 items-center gap-1 text-2xs text-muted-foreground tabular-nums" />
        }
      >
        <SubtaskRing done={done} total={total} />
        {done}/{total} subtasks
      </TooltipTrigger>
      <TooltipPopup side="top">{`${done} of ${total} subtasks finished`}</TooltipPopup>
    </Tooltip>
  );
}

function SubtaskRing({ done, total }: { done: number; total: number }) {
  const circumference = 2 * Math.PI * 5;
  return (
    <svg aria-hidden viewBox="0 0 14 14" className="size-3 -rotate-90">
      <circle cx="7" cy="7" r="5" fill="none" strokeWidth="2" className="stroke-border" />
      <circle
        cx="7"
        cy="7"
        r="5"
        fill="none"
        strokeWidth="2"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - done / total)}
        className="stroke-success"
      />
    </svg>
  );
}

export function TaskProjectLabel({ project }: { project: EnvironmentProject | undefined }) {
  if (project === undefined) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
      <ProjectFavicon project={project} className="size-3" />
      <span className="truncate">{project.title}</span>
    </span>
  );
}

export function TaskUpdatedAt({ task }: { task: TaskNode }) {
  return (
    <span className="shrink-0 text-2xs whitespace-nowrap text-muted-foreground tabular-nums">
      <RelativeTime timestamp={task.thread.updatedAt} />
    </span>
  );
}

export function TaskBranchLabel({ task }: { task: TaskNode }) {
  const branch = task.thread.branch;
  if (!branch) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-2xs text-muted-foreground">
      <GitBranchIcon aria-hidden className="size-3 shrink-0" />
      <MiddleTruncate value={branch} className="flex min-w-0" />
    </span>
  );
}

export function TaskPinnedMark({ task }: { task: TaskNode }) {
  if (task.thread.pinnedAt == null) return null;
  return <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />;
}

/** The task's title, or a field to rename it in place. */
export function TaskTitle({
  task,
  actions,
  className,
}: {
  task: TaskNode;
  actions: TaskActions;
  className?: string;
}) {
  if (actions.rename.renamingKey !== task.key) {
    return <span className={className}>{task.thread.title}</span>;
  }
  return (
    <Input
      autoFocus
      size="sm"
      aria-label="Task title"
      defaultValue={task.thread.title}
      className="pointer-events-auto relative z-10 min-w-0 flex-1"
      onClick={(event) => event.stopPropagation()}
      onBlur={(event) => void actions.rename.commit(task, event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") void actions.rename.commit(task, event.currentTarget.value);
        if (event.key === "Escape") actions.rename.cancel();
      }}
    />
  );
}

const anchorOf = (event: MouseEvent<HTMLElement>) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
};

function QuickAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={label}
            onClick={(event) => {
              event.stopPropagation();
              onClick(event);
            }}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The sidebar's row actions, on a task: mark done or reopen, snooze, and every other action in
 * the menu. They show on hover or focus, and the menu also opens on right-click.
 */
export function TaskQuickActions({
  task,
  actions,
  className,
}: {
  task: TaskNode;
  actions: TaskActions;
  className?: string;
}) {
  if (!actions.canOperate(task)) return null;
  const done = task.status === "done";
  return (
    <span
      className={cn(
        "pointer-events-none z-10 flex shrink-0 items-center opacity-0 transition-opacity group-hover/task:pointer-events-auto group-hover/task:opacity-100 group-focus-within/task:pointer-events-auto group-focus-within/task:opacity-100",
        className,
      )}
    >
      <QuickAction
        label={done ? "Reopen" : "Mark done"}
        onClick={() => void (done ? actions.unsettle(task) : actions.moveTask(task, "done"))}
      >
        {done ? <RotateCcwIcon /> : <CircleCheckIcon />}
      </QuickAction>
      {done ? null : (
        <QuickAction
          label={task.status === "snoozed" ? "Wake" : "Snooze"}
          onClick={(event) => void actions.openSnoozeMenu(task, anchorOf(event))}
        >
          <ClockIcon />
        </QuickAction>
      )}
      <QuickAction
        label="More actions"
        onClick={(event) => void actions.openMenu(task, anchorOf(event))}
      >
        <EllipsisIcon />
      </QuickAction>
    </span>
  );
}

/** Where in Slack the task came from, when the router proposed it from a Slack message. */
export function TaskSlackOrigin({ task }: { task: TaskNode }) {
  const origin = slackOriginOf(task.thread);
  if (origin === null) return null;
  const channel = origin.split(":")[1] ?? "";
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex shrink-0 items-center" />}>
        <SlackIcon aria-label="Slack" role="img" className="size-3 shrink-0" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        {channel.startsWith("D") ? "Proposed from a Slack DM" : `Proposed from Slack #${channel}`}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The model the task's session runs on, with its provider's icon. */
export function TaskModelLabel({ task }: { task: TaskNode }) {
  const { provider, label } = useTaskModel(task.thread);
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-2xs text-muted-foreground">
      {provider === null ? null : (
        <ProviderInstanceIcon
          driverKind={provider.driverKind}
          displayName={provider.displayName}
          accentColor={provider.accentColor}
          acpRegistryAgentId={provider.acpRegistryAgentId}
          acpRegistryIconUrl={provider.acpRegistryIconUrl}
          size="compact"
          className="size-3"
        />
      )}
      <span className="truncate">{label}</span>
    </span>
  );
}
