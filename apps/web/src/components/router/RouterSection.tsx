import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  ACCEPTED_TAG_PREFIX,
  type EnvironmentId,
  isProposalTask,
  readProposalSource,
  ROUTER_TAG,
  type ScheduledTask,
  type ThreadId,
  type ThreadTag,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { RouteIcon } from "lucide-react";
import { useEffect } from "react";

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
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { ProposalRow } from "./ProposalRow";
import { toastManager } from "../ui/toast";
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
          <ProposalRow
            key={task.id}
            environmentId={environmentId}
            task={task}
            active={activeDraftId !== null && proposalDraftFor(task.id) === activeDraftId}
            onOpen={() => void openProposal(environmentId, task)}
            onDiscard={() => void actions.discard(environmentId, task)}
          />
        ))}
      </SidebarMenu>
    </SidebarGroup>
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
      prompt: readProposalSource(task.prompt).brief,
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
