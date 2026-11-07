import { isProposalTask, type ScheduledTask } from "@t3tools/contracts";
import { LightbulbIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ProposalDialog } from "./ProposalDialog";

/**
 * The router's proposals, above the threads: work it suggests, waiting for the user. Each opens with
 * the project, workspace, model and effort the router chose, to change before accepting. Accepting
 * happens only there, with the brief and folder in view: the router reads channel messages anyone
 * can write, and an accepted proposal runs with full access.
 */
export function ProposalsSection() {
  const environmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const connected =
    environmentId !== null &&
    environment?.connection.phase === "connected" &&
    environment.serverConfig !== null;
  const tasks = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  const actions = useProposalActions();
  const [openId, setOpenId] = useState<string | null>(null);
  const proposals = (tasks.data?.tasks ?? []).filter(isProposalTask);
  const open = proposals.find((task) => task.id === openId) ?? null;
  if (environmentId === null || proposals.length === 0) return null;

  return (
    <SidebarGroup>
      <h2 className="flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-sidebar-muted-foreground">
        Proposals
        <span className="tabular-nums opacity-60">{proposals.length}</span>
      </h2>
      <SidebarMenu>
        {proposals.map((task) => (
          <SidebarMenuItem key={task.id} className="group/proposal">
            <SidebarMenuButton onClick={() => setOpenId(task.id)}>
              <LightbulbIcon className="text-primary" />
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
            </SidebarMenuButton>
            <span className="absolute top-1/2 right-1 flex -translate-y-1/2 gap-0.5 rounded-md bg-sidebar-row-hover opacity-0 group-focus-within/proposal:opacity-100 group-hover/proposal:opacity-100">
              <ProposalQuickAction
                label="Discard"
                onClick={() => void actions.discard(environmentId, task)}
              >
                <XIcon />
              </ProposalQuickAction>
            </span>
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
      {open === null ? null : (
        <ProposalDialog
          environmentId={environmentId}
          task={open}
          actions={actions}
          onClose={() => setOpenId(null)}
        />
      )}
    </SidebarGroup>
  );
}

function ProposalQuickAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

/** Accepting runs the proposal once, which starts its worker; discarding deletes it. */
function useProposalActions() {
  const run = useAtomCommand(serverEnvironment.runScheduledTaskNow, {
    label: "proposal accept",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "proposal discard",
  });
  const report = (title: string) => toastManager.add({ type: "error", title });
  return {
    accept: async (
      environmentId: Parameters<typeof run>[0]["environmentId"],
      task: ScheduledTask,
    ) => {
      const result = await run({ environmentId, input: { id: task.id } });
      if (result._tag === "Failure") report("Could not accept the proposal");
      return result._tag === "Success";
    },
    discard: async (
      environmentId: Parameters<typeof remove>[0]["environmentId"],
      task: ScheduledTask,
    ) => {
      const result = await remove({ environmentId, input: { id: task.id } });
      if (result._tag === "Failure") report("Could not discard the proposal");
      return result._tag === "Success";
    },
  };
}

export type ProposalActions = ReturnType<typeof useProposalActions>;
