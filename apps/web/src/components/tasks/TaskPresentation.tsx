import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  EyeIcon,
  LightbulbIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { ProjectFavicon } from "../ProjectFavicon";
import { RelativeTime } from "../RelativeTime";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { subtaskProgress, TASK_COLUMN_LABELS, type TaskColumn, type TaskNode } from "./tasks.logic";

const COLUMN_GLYPHS: Record<TaskColumn, { Icon: LucideIcon; className: string }> = {
  proposed: { Icon: LightbulbIcon, className: "text-primary" },
  todo: { Icon: CircleDashedIcon, className: "text-muted-foreground" },
  in_progress: { Icon: CircleDotIcon, className: "text-info" },
  needs_you: { Icon: CircleAlertIcon, className: "text-warning" },
  in_review: { Icon: EyeIcon, className: "text-success" },
  done: { Icon: CircleCheckIcon, className: "text-muted-foreground" },
  snoozed: { Icon: AlarmClockIcon, className: "text-muted-foreground" },
};

export function TaskColumnGlyph({ column, className }: { column: TaskColumn; className?: string }) {
  const { Icon, className: colorClass } = COLUMN_GLYPHS[column];
  return (
    <Icon
      aria-label={TASK_COLUMN_LABELS[column]}
      className={cn("size-3.5 shrink-0", colorClass, className)}
    />
  );
}

/** The thread's own status pill, the same one the sidebar shows, when it says more than the column. */
export function TaskStatusPill({ task }: { task: TaskNode }) {
  const pill = resolveThreadStatusPill({ thread: task.thread });
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
        {done}/{total}
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
