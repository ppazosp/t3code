import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronDownIcon, KanbanIcon, ListIcon, SearchIcon } from "lucide-react";

import { isElectron } from "~/env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { RouterBar } from "./RouterBar";
import { TaskBoard } from "./TaskBoard";
import { TaskList } from "./TaskList";
import {
  buildTaskTree,
  groupTasksByColumn,
  isRouterThread,
  matchesTaskQuery,
  TASK_COLUMNS,
  type TaskColumn,
  type TaskNode,
} from "./tasks.logic";

export interface TasksSearch {
  readonly view?: "board" | "list" | undefined;
  readonly project?: string | undefined;
  readonly q?: string | undefined;
}

const ALL_PROJECTS = "";

const projectKeyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

export function TasksPage() {
  const search = useSearch({ from: "/_chat/tasks" });
  const navigate = useNavigate({ from: "/tasks" });
  const view = search.view ?? "board";
  const projectFilter = search.project ?? ALL_PROJECTS;
  const query = search.q ?? "";
  const nowMinute = useNowMinute();
  const threads = useThreadShells();
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const settle = useOrchestrationCommand(threadEnvironment.settle);
  const unsettle = useOrchestrationCommand(threadEnvironment.unsettle);
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode);

  const updateSearch = (next: Partial<TasksSearch>) =>
    void navigate({ search: (previous) => ({ ...previous, ...next }), replace: true });

  const router = threads.find(isRouterThread) ?? null;
  const projectByKey = new Map(projects.map((project) => [projectKeyOf(project), project]));
  const projectOf = (task: TaskNode) =>
    projectByKey.get(
      projectKeyOf({ environmentId: task.thread.environmentId, id: task.thread.projectId }),
    );
  const now = new Date(nowMinute).toISOString();
  const tasks = buildTaskTree(threads, now).filter(
    (task) =>
      (projectFilter === ALL_PROJECTS ||
        projectKeyOf({ environmentId: task.thread.environmentId, id: task.thread.projectId }) ===
          projectFilter) &&
      matchesTaskQuery(task, query),
  );
  const grouped = groupTasksByColumn(tasks);
  const columns = TASK_COLUMNS.map((column) => ({ column, tasks: grouped.get(column) ?? [] }))
    // Snoozed work stays out of the way until something is snoozed.
    .filter(({ column, tasks: inColumn }) => column !== "snoozed" || inColumn.length > 0);

  const openTask = (task: TaskNode) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(task.thread.environmentId, task.thread.id)),
    });

  // A card dropped on the board changes what the column stands for, where that is the user's call.
  const moveTask = (task: TaskNode, column: TaskColumn) => {
    const target = {
      environmentId: task.thread.environmentId,
      input: { threadId: task.thread.id },
    };
    if (column === "done") {
      void settle(target);
      return;
    }
    if (task.column === "done") {
      void unsettle({ ...target, input: { ...target.input, reason: "user" } });
    }
    if (column === "proposed" && task.thread.interactionMode !== "plan") {
      void setInteractionMode({ ...target, input: { ...target.input, interactionMode: "plan" } });
    }
  };

  const selectedProject = projectByKey.get(projectFilter);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader electron={isElectron} className="bg-background">
          <WorkspaceBreadcrumb ariaLabel="Tasks breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Tasks</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <WorkspacePageContainer width="expanded" className="max-w-none shrink-0 gap-3 pb-3">
          <RouterBar router={router} projects={projects} now={now} />
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="min-w-0 flex-1 basis-56 **:[input]:h-9 sm:**:[input]:h-8">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label="Search tasks"
                placeholder="Search tasks"
                value={query}
                onChange={(event) => updateSearch({ q: event.currentTarget.value || undefined })}
              />
            </InputGroup>
            <Menu>
              <MenuTrigger render={<Button variant="outline" />} className="min-w-0">
                {selectedProject ? (
                  <ProjectFavicon project={selectedProject} className="size-3.5" />
                ) : null}
                <span className="truncate">{selectedProject?.title ?? "All projects"}</span>
                <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
              </MenuTrigger>
              <MenuPopup align="start" side="bottom">
                <MenuRadioGroup
                  value={projectFilter}
                  onValueChange={(next) => updateSearch({ project: (next as string) || undefined })}
                >
                  <MenuRadioItem value={ALL_PROJECTS}>All projects</MenuRadioItem>
                  {projects.map((project) => (
                    <MenuRadioItem key={projectKeyOf(project)} value={projectKeyOf(project)}>
                      <span className="flex min-w-0 items-center gap-2">
                        <ProjectFavicon project={project} className="size-3.5" />
                        {project.title}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
            <ToggleGroup
              aria-label="Task layout"
              value={[view]}
              onValueChange={(next) => {
                const layout = next[0];
                if (layout === "board" || layout === "list") updateSearch({ view: layout });
              }}
            >
              <Toggle value="board" aria-label="Board">
                <KanbanIcon />
                Board
              </Toggle>
              <Toggle value="list" aria-label="List">
                <ListIcon />
                List
              </Toggle>
            </ToggleGroup>
          </div>
        </WorkspacePageContainer>
        {view === "board" ? (
          <TaskBoard
            columns={columns}
            projectOf={projectOf}
            onOpen={openTask}
            onDropInColumn={moveTask}
          />
        ) : (
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="max-w-none pt-2">
              {tasks.length === 0 ? (
                <p className="px-3 text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <TaskList columns={columns} projectOf={projectOf} onOpen={openTask} />
              )}
            </WorkspacePageContainer>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
