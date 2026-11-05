import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { KanbanIcon, RouteIcon, SearchIcon } from "lucide-react";
import { useState } from "react";

import { isElectron } from "~/env";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadShells } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarInput,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../ui/sidebar";
import { TaskColumnGlyph, TaskQuickActions, TaskStatusPill, TaskTitle } from "./TaskPresentation";
import {
  buildTaskTree,
  groupTasksByColumn,
  isRouterThread,
  matchesTaskQuery,
  TASK_COLUMN_LABELS,
  TASK_COLUMNS,
  type TaskNode,
} from "./tasks.logic";
import { type TaskActions, useTaskActions } from "./useTaskActions";
import { useTaskFamilies } from "./useTaskFamilies";

/**
 * The main sidebar inside a thread: the board's tasks by status, so moving between tasks never
 * needs the board. The board itself shows no sidebar.
 */
export default function TaskSidebar() {
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
  const grouped = groupTasksByColumn(tasks);
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
            <SidebarMenuButton onClick={() => void navigate({ to: "/tasks" })}>
              <KanbanIcon />
              <span>All tasks</span>
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
      <SidebarContent>
        {TASK_COLUMNS.map((column) => {
          const inColumn = grouped.get(column) ?? [];
          if (inColumn.length === 0) return null;
          return (
            <SidebarGroup key={column}>
              <h2 className="flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-sidebar-muted-foreground">
                {TASK_COLUMN_LABELS[column]}
                <span className="tabular-nums opacity-60">{inColumn.length}</span>
              </h2>
              <SidebarMenu>
                {inColumn.map((task) => (
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
        })}
      </SidebarContent>
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
          <TaskColumnGlyph column={task.column} />
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
