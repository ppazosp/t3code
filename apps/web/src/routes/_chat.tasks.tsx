import { createFileRoute } from "@tanstack/react-router";

import { TasksPage, type TasksSearch } from "../components/tasks/TasksPage";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (raw: Record<string, unknown>): TasksSearch => ({
    ...(raw.view === "board" || raw.view === "list" ? { view: raw.view } : {}),
    ...(typeof raw.project === "string" && raw.project
      ? { project: raw.project.slice(0, 200) }
      : {}),
    // Always include q to override numeric values in the parent route's unvalidated search.
    q: typeof raw.q === "string" && raw.q ? raw.q.slice(0, 200) : undefined,
  }),
  component: TasksPage,
});
