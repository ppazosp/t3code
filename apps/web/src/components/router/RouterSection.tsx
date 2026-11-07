import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  ACCEPTED_TAG_PREFIX,
  type EnvironmentId,
  isProposalTask,
  ROUTER_TAG,
  type ScheduledTask,
  type ThreadId,
  type ThreadTag,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LightbulbIcon, RouteIcon, XIcon } from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useThreadShells } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  forgetProposalDraft,
  proposalDraftFor,
  readProposalDrafts,
  rememberProposalDraft,
} from "./proposalDrafts";

/** The router's proposals in the primary environment, where the router lives. */
export function useProposals() {
  const environmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const connected =
    environmentId !== null &&
    environment?.connection.phase === "connected" &&
    environment.serverConfig !== null;
  const tasks = useEnvironmentQuery(
    connected ? serverEnvironment.scheduledTasksLive({ environmentId, input: {} }) : null,
  );
  return { environmentId, proposals: (tasks.data?.tasks ?? []).filter(isProposalTask) };
}

/**
 * The router and its proposals, above the threads; the list shows even when empty. A proposal opens
 * as a T3 draft with the router's choices set, so it is edited and sent like any new chat.
 */
export function RouterSection() {
  const navigate = useNavigate();
  const routeTarget = useThreadRouteTarget();
  const threads = useThreadShells();
  const router = threads.find(
    (thread) => thread.source.tags?.includes(ROUTER_TAG) === true && thread.archivedAt === null,
  );
  const routerActive =
    router !== undefined &&
    routeTarget?.kind === "server" &&
    scopedThreadKey(routeTarget.threadRef) ===
      scopedThreadKey(scopeThreadRef(router.environmentId, router.id));
  const { environmentId, proposals } = useProposals();
  const actions = useProposalActions();
  const openProposal = useOpenProposal();
  const setTag = useOrchestrationCommand(threadEnvironment.setTag);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the server which proposal a sent draft accepted, once its thread exists
  useEffect(() => {
    for (const [draftId, entry] of Object.entries(readProposalDrafts())) {
      const sent = threads.some(
        (thread) => thread.id === entry.threadId && thread.environmentId === entry.environmentId,
      );
      if (!sent) continue;
      forgetProposalDraft(draftId);
      void setTag({
        environmentId: entry.environmentId as EnvironmentId,
        input: {
          threadId: entry.threadId as ThreadId,
          tag: `${ACCEPTED_TAG_PREFIX}${entry.taskId}` as ThreadTag,
          tagged: true,
        },
      });
    }
  }, [threads, setTag]);

  if (environmentId === null || router === undefined) return null;
  const activeDraftId = routeTarget?.kind === "draft" ? routeTarget.draftId : null;

  return (
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            isActive={routerActive}
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(router.environmentId, router.id)),
              })
            }
          >
            <RouteIcon />
            <span>Router</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <h2 className="flex h-7 items-center gap-1.5 px-2.5 text-xs font-medium text-sidebar-muted-foreground">
        Proposals
        <span className="tabular-nums opacity-60">{proposals.length}</span>
      </h2>
      {proposals.length === 0 ? (
        <p className="px-2.5 pb-1 text-xs text-sidebar-muted-foreground/70">
          Nothing proposed. The router adds work here for you to accept.
        </p>
      ) : null}
      <SidebarMenu>
        {proposals.map((task) => (
          <SidebarMenuItem key={task.id} className="group/proposal">
            <SidebarMenuButton
              isActive={activeDraftId !== null && proposalDraftFor(task.id) === activeDraftId}
              onClick={() => void openProposal(environmentId, task)}
            >
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
  children: ReactNode;
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

/**
 * Opens a proposal as a T3 draft: its brief in the composer, and the router's model, effort, mode
 * and workspace set, all changeable with the composer's own controls. Sending it accepts it. A
 * proposal opened before returns to its draft.
 */
function useOpenProposal() {
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();
  return async (environmentId: EnvironmentId, task: ScheduledTask) => {
    const store = useComposerDraftStore.getState();
    const existing = proposalDraftFor(task.id);
    const session = existing === null ? null : store.getDraftSession(DraftId.make(existing));
    if (existing !== null && session !== null && session.promotedTo == null) {
      await navigate({ to: "/draft/$draftId", params: { draftId: existing } });
      return;
    }
    const workspace = task.workspaceStrategy;
    const opened = await handleNewThread(scopeProjectRef(environmentId, task.projectId), {
      ...(workspace.type === "worktree"
        ? {
            envMode: "worktree" as const,
            branch: workspace.baseRef,
            startFromOrigin: workspace.startFromOrigin ?? false,
          }
        : workspace.type === "existing_worktree"
          ? { envMode: "worktree" as const, worktreePath: workspace.worktreePath }
          : { envMode: "local" as const, branch: null, worktreePath: null }),
      prompt: task.prompt,
    });
    if (opened === null) return;
    store.setModelSelection(opened.draftId, task.modelSelection, {
      explicit: true,
      replaceOptions: true,
    });
    store.setInteractionMode(opened.draftId, task.interactionMode);
    store.setRuntimeMode(opened.draftId, task.runtimeMode);
    rememberProposalDraft(opened.draftId, {
      environmentId,
      taskId: task.id,
      threadId: opened.threadId,
    });
  };
}

/** Discarding deletes the proposal; accepting is sending its draft. */
export function useProposalActions() {
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "proposal discard",
  });
  return {
    discard: async (environmentId: EnvironmentId, task: ScheduledTask) => {
      const result = await remove({ environmentId, input: { id: task.id } });
      if (result._tag === "Failure") {
        toastManager.add({ type: "error", title: "Could not discard the proposal" });
        return false;
      }
      const draftId = proposalDraftFor(task.id);
      if (draftId !== null) {
        forgetProposalDraft(draftId);
        useComposerDraftStore.getState().clearDraftThread(DraftId.make(draftId));
      }
      return true;
    },
  };
}
