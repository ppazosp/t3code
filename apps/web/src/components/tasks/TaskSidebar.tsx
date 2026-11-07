import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { KanbanIcon, ListIcon, RouteIcon, SearchIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { isElectron } from "~/env";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects, useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { THREAD_SIDEBAR_WIDTH_STORAGE_KEY } from "../threadSidebarWidth";
import {
  SidebarContent,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { TaskBoard } from "./TaskBoard";
import { TaskStatusGlyph, TaskQuickActions, TaskStatusPill, TaskTitle } from "./TaskPresentation";
import {
  BOARD_COLUMNS,
  buildTaskTree,
  HIDDEN_COLUMNS,
  groupTasksByStatus,
  isRouterThread,
  matchesTaskQuery,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
  type TaskNode,
} from "./tasks.logic";
import { type TaskActions, useTaskActions } from "./useTaskActions";
import { useTaskFamilies } from "./useTaskFamilies";

/** From this width the sidebar shows the task board instead of the task list. */
const BOARD_MIN_WIDTH = 600;

/** The list's width when the board folds back into it. */
const LIST_WIDTH = 16 * 16;

const projectKeyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

/**
 * T3's main sidebar, as tasks: a list by status beside the open thread, and the task board once
 * the sidebar is dragged wide. "All tasks" switches between the two.
 */
export default function TaskSidebar({
  width,
  maxWidth,
  onWidthChange,
}: {
  width: number;
  maxWidth: number;
  onWidthChange: (width: number) => void;
}) {
  const navigate = useNavigate();
  const routeTarget = useThreadRouteTarget();
  const threads = useThreadShells();
  const nowMinute = useNowMinute();
  const actions = useTaskActions();
  const [query, setQuery] = useState("");
  useTaskFamilies(threads);

  const activeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;
  const router = threads.find(isRouterThread) ?? null;
  const tasks = buildTaskTree(threads, new Date(nowMinute).toISOString()).filter((task) =>
    matchesTaskQuery(task, query),
  );
  const grouped = groupTasksByStatus(tasks);
  const projects = useProjects();
  const projectByKey = new Map(projects.map((project) => [projectKeyOf(project), project]));
  const projectOf = (task: TaskNode) =>
    projectByKey.get(
      projectKeyOf({ environmentId: task.thread.environmentId, id: task.thread.projectId }),
    );
  const toColumn = (column: (typeof BOARD_COLUMNS)[number] | (typeof HIDDEN_COLUMNS)[number]) => ({
    id: column.id,
    label: column.label,
    tasks: column.statuses.flatMap((status) => grouped.get(status) ?? []),
  });
  const board = width >= BOARD_MIN_WIDTH;
  // Saved like a dragged width, so the sidebar opens as it was left.
  const setWidth = (next: number) => {
    onWidthChange(next);
    try {
      setLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, next, Schema.Finite);
    } catch (error) {
      console.error("Could not save the sidebar width.", error);
    }
  };
  const open = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarGroup>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              aria-pressed={board}
              onClick={() => setWidth(board ? LIST_WIDTH : Math.max(BOARD_MIN_WIDTH, maxWidth))}
            >
              {board ? <ListIcon /> : <KanbanIcon />}
              <span>{board ? "Task list" : "Task board"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          {router ? (
            <SidebarMenuItem>
              <SidebarMenuButton
                isActive={
                  activeKey === scopedThreadKey(scopeThreadRef(router.environmentId, router.id))
                }
                onClick={() => open(router)}
              >
                <RouteIcon />
                <span>Router</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ) : null}
          <SidebarMenuItem>
            <SidebarMenuButton render={<label />}>
              <SearchIcon />
              <SidebarInput
                type="search"
                aria-label="Search tasks"
                placeholder="Search tasks"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
      {board ? (
        <TaskBoard
          columns={BOARD_COLUMNS.map(toColumn)}
          hiddenColumns={HIDDEN_COLUMNS.map(toColumn)}
          projectOf={projectOf}
          actions={actions}
          selectedKey={activeKey}
          onOpen={(task) => open(task.thread)}
        />
      ) : (
        <SidebarContent>
          {TASK_STATUSES.filter((status) => status !== "done" && status !== "snoozed").map(
            (status) => {
              const inStatus = grouped.get(status) ?? [];
              if (inStatus.length === 0) return null;
              return (
                <SidebarGroup key={status}>
                  <h2 className="flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-sidebar-muted-foreground">
                    {TASK_STATUS_LABELS[status]}
                    <span className="tabular-nums opacity-60">{inStatus.length}</span>
                  </h2>
                  <SidebarMenu>
                    {inStatus.map((task) => (
                      <TaskSidebarRow
                        key={task.key}
                        task={task}
                        depth={0}
                        activeKey={activeKey}
                        actions={actions}
                        onOpen={(node) => open(node.thread)}
                      />
                    ))}
                  </SidebarMenu>
                </SidebarGroup>
              );
            },
          )}
        </SidebarContent>
      )}
      <SidebarChromeFooter />
    </>
  );
}

function TaskSidebarRow({
  task,
  depth,
  activeKey,
  actions,
  onOpen,
}: {
  task: TaskNode;
  depth: number;
  activeKey: string | null;
  actions: TaskActions;
  onOpen: (task: TaskNode) => void;
}) {
  return (
    <>
      <SidebarMenuItem
        className="group/task"
        onContextMenu={(event) => {
          event.preventDefault();
          void actions.openMenu(task, { x: event.clientX, y: event.clientY });
        }}
      >
        <SidebarMenuButton
          isActive={task.key === activeKey}
          onClick={() => onOpen(task)}
          style={depth === 0 ? undefined : { paddingLeft: `${0.625 + depth * 0.875}rem` }}
        >
          <TaskStatusGlyph status={task.status} />
          <TaskTitle task={task} actions={actions} className="min-w-0 flex-1 truncate" />
          <span className="shrink-0 group-hover/task:hidden group-focus-within/task:hidden">
            <TaskStatusPill task={task} />
          </span>
        </SidebarMenuButton>
        <TaskQuickActions
          task={task}
          actions={actions}
          className="absolute top-1/2 right-1 -translate-y-1/2 rounded-md bg-sidebar-row-hover"
        />
      </SidebarMenuItem>
      {task.subtasks.map((subtask) => (
        <TaskSidebarRow
          key={subtask.key}
          task={subtask}
          depth={depth + 1}
          activeKey={activeKey}
          actions={actions}
          onOpen={onOpen}
        />
      ))}
    </>
  );
}
