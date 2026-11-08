import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  isProposalTask,
  readProposalSource,
  ROUTER_TAG,
  type ScheduledTask,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, RouteIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { cn, newDraftId, newThreadId } from "~/lib/utils";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import { useThreadShells } from "../../state/entities";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
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
  rememberUnarchivedFor,
  takeUnarchivedFor,
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

/** The proposal waiting to continue a thread, if the router made one. */
export function useFollowUpProposal(environmentId: string | null, threadId: string | null) {
  const { environmentId: proposalsEnvironment, proposals } = useProposals();
  if (environmentId === null || threadId === null || environmentId !== proposalsEnvironment) {
    return undefined;
  }
  return proposals.find((task) => task.threadId === threadId);
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
  const [proposalsOpen, setProposalsOpen] = useLocalStorage(
    "super-t3:proposals-open",
    true,
    Schema.Boolean,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forgets a proposal's draft once its thread exists; the send already tagged it accepted
  useEffect(() => {
    for (const [draftId, entry] of Object.entries(readProposalDrafts())) {
      const sent = threads.some(
        (thread) => thread.id === entry.threadId && thread.environmentId === entry.environmentId,
      );
      if (sent) forgetProposalDraft(draftId);
    }
  }, [threads]);

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
      <button
        type="button"
        aria-expanded={proposalsOpen}
        onClick={() => setProposalsOpen(!proposalsOpen)}
        className="flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-sidebar-muted-foreground outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn("size-3 transition-transform", proposalsOpen && "rotate-90")}
        />
        Proposals
        <span className="tabular-nums opacity-60">{proposals.length}</span>
      </button>
      {proposalsOpen ? (
        <>
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
                active={
                  task.threadId !== null
                    ? routeTarget?.kind === "server" &&
                      routeTarget.threadRef.threadId === task.threadId
                    : activeDraftId !== null && proposalDraftFor(task.id) === activeDraftId
                }
                onOpen={() => void openProposal(environmentId, task)}
                onDiscard={() => void actions.discard(environmentId, task)}
              />
            ))}
          </SidebarMenu>
        </>
      ) : null}
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
  const threads = useThreadShells();
  const unarchive = useOrchestrationCommand(threadEnvironment.unarchive, { reportFailure: false });
  return async (environmentId: EnvironmentId, task: ScheduledTask) => {
    const store = useComposerDraftStore.getState();
    // A proposal to continue a thread opens in that thread, with the brief in its composer.
    if (task.threadId !== null) {
      const threadRef = scopeThreadRef(environmentId, task.threadId);
      // Archived threads are not listed or opened, so the proposal brings it back first.
      const listed = threads.some(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.id === task.threadId &&
          thread.archivedAt === null,
      );
      if (!listed) {
        const result = await unarchive({ environmentId, input: { threadId: task.threadId } });
        if (result._tag === "Success") {
          rememberUnarchivedFor(task.id, { environmentId, threadId: task.threadId });
        }
      }
      if ((store.getComposerDraft(threadRef)?.prompt ?? "").trim() === "") {
        store.setPrompt(threadRef, readProposalSource(task.prompt).brief);
      }
      store.setInteractionMode(threadRef, task.interactionMode);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
      return;
    }
    const existing = proposalDraftFor(task.id);
    const session = existing === null ? null : store.getDraftSession(DraftId.make(existing));
    if (existing !== null && session !== null && session.promotedTo == null) {
      await navigate({ to: "/draft/$draftId", params: { draftId: existing } });
      return;
    }
    const draftId = newDraftId();
    const threadId = newThreadId();
    // Linked before the draft exists, so the sidebar never lists it as an ordinary draft.
    rememberProposalDraft(draftId, { environmentId, taskId: task.id, threadId });
    const workspace = task.workspaceStrategy;
    store.setProjectDraftThreadId(scopeProjectRef(environmentId, task.projectId), draftId, {
      threadId,
      createdAt: new Date().toISOString(),
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
      ...(workspace.type === "worktree"
        ? {
            envMode: "worktree" as const,
            branch: workspace.baseRef,
            worktreePath: null,
            startFromOrigin: workspace.startFromOrigin ?? false,
          }
        : workspace.type === "existing_worktree"
          ? { envMode: "worktree" as const, branch: null, worktreePath: workspace.worktreePath }
          : { envMode: "local" as const, branch: null, worktreePath: null }),
    });
    store.setPrompt(draftId, readProposalSource(task.prompt).brief);
    // The composer sends with its own modes, so they are set there as well as on the draft thread.
    store.setRuntimeMode(draftId, task.runtimeMode);
    store.setInteractionMode(draftId, task.interactionMode);
    store.setModelSelection(draftId, task.modelSelection, { explicit: true, replaceOptions: true });
    await navigate({ to: "/draft/$draftId", params: { draftId } });
  };
}

/** Discarding deletes the proposal; accepting is sending its draft. */
export function useProposalActions() {
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "proposal discard",
  });
  const archive = useOrchestrationCommand(threadEnvironment.archive, { reportFailure: false });
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
      if (task.threadId !== null) {
        // The brief it put in the thread's composer goes with it, unless the user changed it.
        const store = useComposerDraftStore.getState();
        const threadRef = scopeThreadRef(environmentId, task.threadId);
        if (store.getComposerDraft(threadRef)?.prompt === readProposalSource(task.prompt).brief) {
          store.setPrompt(threadRef, "");
        }
        // A thread the proposal brought back from the archive goes back there.
        const unarchived = takeUnarchivedFor(task.id);
        if (unarchived !== undefined) {
          await archive({
            environmentId: unarchived.environmentId as EnvironmentId,
            input: { threadId: unarchived.threadId as ThreadId },
          });
        }
      }
      return true;
    },
  };
}
