import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChartNoAxesColumnIcon,
  ChevronDownIcon,
  KanbanIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";
import type { ChatComposerHandle } from "../chat/ChatComposer";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects, useThreadShells } from "../../state/entities";
import { usePullRequestsSupported } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ProjectFavicon } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Toggle as GroupToggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../WorkspacePageContainer";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { RouterPanel } from "./RouterPanel";
import { RouterSetup } from "./RouterSetup";
import { TaskBoard } from "./TaskBoard";
import { TaskList } from "./TaskList";
import {
  BOARD_COLUMNS,
  type BoardColumnId,
  buildTaskTree,
  groupTasksByStatus,
  HIDDEN_COLUMNS,
  HIDDEN_STATUSES,
  isRouterThread,
  matchesTaskQuery,
  TASK_STATUSES,
  type TaskNode,
  type TaskStatus,
} from "./tasks.logic";
import { useTaskActions } from "./useTaskActions";
import { useTaskFamilies } from "./useTaskFamilies";

export interface TasksSearch {
  readonly view?: "board" | "list" | undefined;
  readonly project?: string | undefined;
  readonly q?: string | undefined;
}

const ALL_PROJECTS = "";

const projectKeyOf = (project: Pick<EnvironmentProject, "environmentId" | "id">) =>
  `${project.environmentId}:${project.id}`;

/** Keys typed into a field, or with a modifier, belong to that field or to the app. */
function isTypingTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  return (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    (target instanceof HTMLElement &&
      (target.isContentEditable || target.closest("input, textarea, select, [role=menu]") !== null))
  );
}

export function TasksPage() {
  const search = useSearch({ from: "/_chat/tasks" });
  const navigate = useNavigate({ from: "/tasks" });
  const view = search.view ?? "board";
  const projectFilter = search.project ?? ALL_PROJECTS;
  const query = search.q ?? "";
  const nowMinute = useNowMinute();
  const threads = useThreadShells();
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const actions = useTaskActions();
  const handleNewThread = useNewThreadHandler();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<ChatComposerHandle | null>(null);
  const [routerOpen, setRouterOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<ReadonlySet<TaskStatus>>(new Set());
  useTaskFamilies(threads);

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
  const grouped = groupTasksByStatus(tasks);
  const sections = TASK_STATUSES.map((status) => ({
    status,
    tasks: grouped.get(status) ?? [],
    folded: HIDDEN_STATUSES.has(status) && !unfolded.has(status),
  }));
  const toggleFolded = (status: TaskStatus) => {
    const next = new Set(unfolded);
    if (!next.delete(status)) next.add(status);
    setUnfolded(next);
  };
  const toColumn = (column: {
    id: BoardColumnId;
    label: string;
    statuses: ReadonlyArray<TaskStatus>;
  }) => ({
    id: column.id,
    label: column.label,
    tasks: column.statuses.flatMap((status) => grouped.get(status) ?? []),
  });
  const columns = BOARD_COLUMNS.map(toColumn);
  const hiddenColumns = HIDDEN_COLUMNS.map(toColumn);
  // Keyboard order follows what is on screen: down each column on the board, down the list.
  const ordered =
    view === "list"
      ? sections.flatMap(({ tasks: inStatus, folded }) =>
          (folded ? [] : inStatus).flatMap(function walk(task): TaskNode[] {
            return [task, ...task.subtasks.flatMap(walk)];
          }),
        )
      : columns.flatMap((column) => column.tasks);

  const openTask = (task: TaskNode) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(task.thread.environmentId, task.thread.id)),
    });

  const selectedProject = projectByKey.get(projectFilter);
  const newTaskProjects = selectedProject ? [selectedProject] : projects;
  const startNewTask = (project: EnvironmentProject) =>
    void handleNewThread(scopeProjectRef(project.environmentId, project.id));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keydown for the board's keyboard shortcuts with the tasks on screen
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTypingTarget(event)) return;
      const index = ordered.findIndex((task) => task.key === selectedKey);
      const select = (task: TaskNode | undefined) => {
        if (task === undefined) return;
        event.preventDefault();
        setSelectedKey(task.key);
        document
          .querySelector(`[data-task-key="${CSS.escape(task.key)}"]`)
          ?.scrollIntoView({ block: "nearest" });
      };
      switch (event.key) {
        case "j":
        case "ArrowDown":
          select(ordered[index + 1] ?? ordered[0]);
          return;
        case "k":
        case "ArrowUp":
          select(ordered[index - 1] ?? ordered.at(-1));
          return;
        case "Enter":
          if (index >= 0) {
            event.preventDefault();
            openTask(ordered[index]!);
          }
          return;
        case "Escape":
          setSelectedKey(null);
          return;
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          return;
        case "c":
          if (router === null) return;
          event.preventDefault();
          setRouterOpen(true);
          // The panel shows on the next frame; its composer can take focus after that.
          requestAnimationFrame(() => composerRef.current?.focusAtEnd());
          return;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        {/* With no sidebar here, the title clears the window buttons itself. */}
        <WorkspacePageHeader
          electron={isElectron}
          className={cn("bg-background", isElectron && "pl-(--workspace-controls-left)")}
        >
          <WorkspaceBreadcrumb ariaLabel="Tasks breadcrumb">
            <WorkspaceBreadcrumbItem current>
              <h1 className="truncate">Tasks</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
          <AppLinks />
        </WorkspacePageHeader>
        <WorkspacePageContainer width="expanded" className="max-w-none shrink-0 gap-3 pb-3">
          {router === null ? <RouterSetup projects={projects} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <InputGroup className="min-w-0 flex-1 basis-56 **:[input]:h-9 sm:**:[input]:h-8">
              <InputGroupAddon>
                <SearchIcon aria-hidden />
              </InputGroupAddon>
              <InputGroupInput
                ref={searchRef}
                type="search"
                aria-label="Search tasks"
                placeholder="Search tasks"
                value={query}
                onChange={(event) => updateSearch({ q: event.currentTarget.value || undefined })}
                onKeyDown={(event) => {
                  if (event.key === "Escape") event.currentTarget.blur();
                }}
              />
              <InputGroupAddon align="inline-end">
                <Kbd>/</Kbd>
              </InputGroupAddon>
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
              <GroupToggle value="board" aria-label="Board">
                <KanbanIcon />
                Board
              </GroupToggle>
              <GroupToggle value="list" aria-label="List">
                <ListIcon />
                List
              </GroupToggle>
            </ToggleGroup>
            <Menu>
              <MenuTrigger
                render={<Button variant="outline" />}
                disabled={newTaskProjects.length === 0}
              >
                <PlusIcon aria-hidden />
                New task
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                {newTaskProjects.map((project) => (
                  <MenuItem key={projectKeyOf(project)} onClick={() => startNewTask(project)}>
                    <ProjectFavicon project={project} className="size-3.5" />
                    {project.title}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          </div>
        </WorkspacePageContainer>
        {view === "board" ? (
          <TaskBoard
            columns={columns}
            hiddenColumns={hiddenColumns}
            projectOf={projectOf}
            actions={actions}
            selectedKey={selectedKey}
            onOpen={openTask}
          />
        ) : (
          <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="expanded" className="max-w-none pt-2">
              {tasks.length === 0 ? (
                <p className="px-3 text-sm text-muted-foreground">No tasks yet.</p>
              ) : (
                <TaskList
                  sections={sections}
                  onToggleFolded={toggleFolded}
                  projectOf={projectOf}
                  actions={actions}
                  selectedKey={selectedKey}
                  onOpen={openTask}
                />
              )}
            </WorkspacePageContainer>
          </div>
        )}
        {router === null ? null : (
          <RouterPanel
            router={router}
            now={now}
            composerRef={composerRef}
            open={routerOpen}
            onOpenChange={setRouterOpen}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function AppLink({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-sm" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** What the sidebar's footer offered, now that the board has no sidebar. */
function AppLinks() {
  const navigate = useNavigate();
  const pullRequestsSupported = usePullRequestsSupported();
  return (
    <div className="ml-auto flex items-center gap-0.5">
      {pullRequestsSupported ? (
        <AppLink
          label="Pull requests"
          onClick={() =>
            void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
          }
        >
          <PullRequestGlyph.pullRequest />
        </AppLink>
      ) : null}
      <AppLink label="Usage" onClick={() => void navigate({ to: "/usage" })}>
        <ChartNoAxesColumnIcon />
      </AppLink>
      <AppLink label="Settings" onClick={() => void navigate({ to: "/settings" })}>
        <SettingsIcon />
      </AppLink>
    </div>
  );
}
