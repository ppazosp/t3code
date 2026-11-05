import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { CornerLeftUpIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { canApproveTask, TaskApproveButton } from "./TaskApproveButton";
import { TaskStatusGlyph, TaskStatusPill, TaskSubtaskCount } from "./TaskPresentation";
import {
  buildTaskTree,
  findTask,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type TaskStatus,
  type TaskNode,
} from "./tasks.logic";
import { SETTABLE_TASK_STATUSES, useTaskActions } from "./useTaskActions";

/**
 * The thread as a task, at the top of its details panel: its status, which the user can change
 * where that is their call, the task it belongs to, its subtasks, and Approve for a proposal.
 */
export function TaskDetailsSection({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const navigate = useNavigate();
  const threads = useThreadShells();
  const nowMinute = useNowMinute();
  const actions = useTaskActions();
  const key = scopedThreadKey(scopeThreadRef(environmentId, threadId));
  const found = findTask(buildTaskTree(threads, new Date(nowMinute).toISOString()), key);
  // The router and side chats are not tasks.
  if (found === null) return null;
  const { task, parent } = found;
  const open = (node: TaskNode) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(node.thread.environmentId, node.thread.id)),
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-task-heading"
      title={parent === null ? "Task" : "Subtask"}
      separated={false}
      actions={<TaskStatusPill task={task} />}
    >
      <div className="flex flex-col">
        <p className="px-2.5 pb-1.5 text-sm leading-snug font-medium text-foreground">
          {task.thread.title}
        </p>
        <Menu>
          <MenuTrigger
            render={<ThreadDetailsControl part="row" />}
            disabled={!actions.canOperate(task)}
          >
            <TaskStatusGlyph status={task.status} className="size-4" />
            <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>
              {TASK_STATUS_LABELS[task.status]}
            </span>
          </MenuTrigger>
          <MenuPopup align="start" side="bottom">
            <MenuRadioGroup
              value={task.status}
              onValueChange={(next) => void actions.moveTask(task, next as TaskStatus)}
            >
              {TASK_STATUSES.filter((status) => status !== "snoozed").map((status) => (
                <MenuRadioItem
                  key={status}
                  value={status}
                  disabled={status !== task.status && !SETTABLE_TASK_STATUSES.has(status)}
                >
                  <span className="flex items-center gap-2">
                    <TaskStatusGlyph status={status} />
                    {TASK_STATUS_LABELS[status]}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        {parent === null ? null : (
          <ThreadDetailsControl part="row" onClick={() => open(parent)}>
            <CornerLeftUpIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
            <span className={`truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
              {parent.thread.title}
            </span>
          </ThreadDetailsControl>
        )}
        {task.subtasks.length === 0 ? null : (
          <>
            <div className="flex h-7 items-center gap-2 px-2.5 pt-1 text-2xs text-muted-foreground">
              Subtasks
              <TaskSubtaskCount task={task} />
            </div>
            {task.subtasks.map((subtask) => (
              <ThreadDetailsControl key={subtask.key} part="row" onClick={() => open(subtask)}>
                <TaskStatusGlyph status={subtask.status} className="size-4" />
                <span className={`truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
                  {subtask.thread.title}
                </span>
              </ThreadDetailsControl>
            ))}
          </>
        )}
        {canApproveTask(task) ? (
          <div className="flex justify-end px-2.5 pt-1.5">
            <TaskApproveButton task={task} />
          </div>
        ) : null}
      </div>
    </ThreadDetailsSection>
  );
}
