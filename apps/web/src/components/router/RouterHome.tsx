import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ROUTER_TAG } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useThreadShells,
} from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SidebarInset } from "../ui/sidebar";
import { RouterSetup } from "./RouterSetup";

/**
 * Home is the router: its conversation opens beside the task sidebar. Until there is a router, home
 * offers to set one up; `children`, T3's own home, shows only once threads are known.
 */
export function RouterHome({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const router = useThreadShells().find(
    (thread) => thread.source.tags?.includes(ROUTER_TAG) === true && thread.archivedAt === null,
  );
  const projects = useProjects().filter((project) => project.archivedAt == null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the router once the thread list shows one
  useEffect(() => {
    if (router === undefined) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(router.environmentId, router.id)),
      replace: true,
    });
  }, [navigate, router]);

  if (!bootstrapped || router !== undefined) return null;
  if (projects.length === 0) return children;
  return (
    <SidebarInset className="scrollbar-gutter-both h-dvh min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center p-6">
        <RouterSetup projects={projects} />
      </div>
    </SidebarInset>
  );
}
