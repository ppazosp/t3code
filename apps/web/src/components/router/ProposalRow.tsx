import { useAtomValue } from "@effect/atom-react";
import { readProposalSource, type EnvironmentId, type ScheduledTask } from "@t3tools/contracts";
import { FolderIcon, FolderTreeIcon, LightbulbIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { SidebarMenuItem } from "../ui/sidebar";
import { SourceIcon } from "./SourceIcon";

function workspaceLabel(workspace: ScheduledTask["workspaceStrategy"]): string {
  if (workspace.type === "worktree") return `New worktree from ${workspace.baseRef}`;
  if (workspace.type === "root") return "Project folder";
  return workspace.worktreePath.split("/").filter(Boolean).at(-1) ?? workspace.worktreePath;
}

/**
 * A proposal in the sidebar, laid out like a thread row: its project, its title, where it came from,
 * and where and on which provider it would run, as the router set them until the user changes them.
 */
export function ProposalRow({
  environmentId,
  task,
  active,
  onOpen,
  onDiscard,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  active: boolean;
  onOpen: () => void;
  onDiscard: () => void;
}) {
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.id === task.projectId,
  );
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const provider = providerInstanceEntriesFor(providers, settings, task.projectId).find(
    (entry) => entry.instanceId === task.modelSelection.instanceId,
  );
  const { source } = readProposalSource(task.prompt);

  return (
    <SidebarMenuItem className="group/proposal">
      <button
        type="button"
        onClick={onOpen}
        className={cn(
          "flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left outline-hidden hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          active && "bg-sidebar-row-selected",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
          {project === undefined ? null : <ProjectFavicon project={project} className="size-3.5" />}
          <span className="truncate">{project?.title ?? "Project"}</span>
          {/* Kept in the layout while Discard covers it, so nothing shifts on hover. */}
          <span className="ml-auto flex shrink-0 items-center gap-1 text-primary group-focus-within/proposal:invisible group-hover/proposal:invisible">
            <LightbulbIcon aria-hidden className="size-3.5" />
            Proposal
          </span>
        </span>
        <span className="truncate text-sm text-sidebar-foreground">{task.title}</span>
        {source === null ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
            <SourceIcon kind={source.kind} className="size-3.5 shrink-0" />
            <span className="truncate">
              {source.where} · {source.author}
            </span>
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground">
          {task.workspaceStrategy.type === "root" ? (
            <FolderIcon aria-hidden className="size-3.5 shrink-0" />
          ) : (
            <FolderTreeIcon aria-hidden className="size-3.5 shrink-0" />
          )}
          <span className="truncate">{workspaceLabel(task.workspaceStrategy)}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {provider === undefined ? null : (
              <ProviderInstanceIcon
                driverKind={provider.driverKind}
                displayName={provider.displayName}
                accentColor={provider.accentColor}
                acpRegistryAgentId={provider.acpRegistryAgentId}
                acpRegistryIconUrl={provider.acpRegistryIconUrl}
                size="compact"
                iconClassName="opacity-60"
              />
            )}
          </span>
        </span>
      </button>
      {/* Takes the Proposal badge's place on hover. */}
      <span className="absolute top-1 right-1.5 opacity-0 group-focus-within/proposal:opacity-100 group-hover/proposal:opacity-100">
        <Button size="icon-xs" variant="ghost-muted" aria-label="Discard" onClick={onDiscard}>
          <XIcon />
        </Button>
      </span>
    </SidebarMenuItem>
  );
}
