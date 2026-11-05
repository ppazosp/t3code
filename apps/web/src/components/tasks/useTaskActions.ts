import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeCanArchive } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { canSnooze } from "@t3tools/client-runtime/state/thread-settled";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import {
  derivePhysicalProjectKey,
  selectProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  PROPOSAL_TAG,
  type ThreadTag,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { getClientSettings, useClientSettings } from "../../hooks/useSettings";
import { useThreadActions } from "../../hooks/useThreadActions";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { readLocalApi } from "../../localApi";
import { buildPhysicalToLogicalProjectKeyMap } from "../../sidebarProjectGrouping";
import { readProjects, useServerConfigs } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { requestCustomSnooze } from "../CustomSnoozeDialog";
import { pickSnoozePreset, resolveSnoozePresets } from "../Sidebar.snooze";
import {
  buildThreadActionMenuItems,
  threadActionRequiresOperate,
  type ThreadActionMenuId,
} from "../threadActionMenu.logic";
import { toastManager } from "../ui/toast";
import { TASK_STATUS_LABELS, TASK_STATUSES, type TaskStatus, type TaskNode } from "./tasks.logic";

/** Statuses a user can move a task into. The rest follow what the task's agent is doing. */
export const SETTABLE_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set(["proposed", "done"]);

// "status" names the submenu itself, which is never picked.
type TaskMenuId = ThreadActionMenuId | "status" | `status:${TaskStatus}`;

function reportFailure(title: string, result: { readonly _tag: string }) {
  if (result._tag !== "Failure") return;
  if (isAtomCommandInterrupted(result as never)) return;
  const error = squashAtomCommandFailure(result as never);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "An error occurred.",
  });
}

/** The thread menu's labels say "task" here, since that is what the user sees. */
function relabelForTasks<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
): ReadonlyArray<ContextMenuItem<T>> {
  return items.map((item) => ({
    ...item,
    // "New thread on <branch>" really starts a thread, so it keeps its word.
    label: item.label.replace(/\bthread\b(?! on )/u, "task"),
    ...(item.children ? { children: relabelForTasks(item.children) } : {}),
  }));
}

/**
 * Everything the thread sidebar does to a thread, for a task: its status, settle and snooze, pin,
 * rename, copy, archive and delete. Cards, rows, the task sidebar and the details panel share it.
 */
export function useTaskActions() {
  const threadActions = useThreadActions();
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode, {
    reportFailure: false,
  });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const setTag = useOrchestrationCommand(threadEnvironment.setTag, { reportFailure: false });
  const serverConfigs = useServerConfigs();
  const handleNewThread = useNewThreadHandler();
  const navigate = useNavigate();
  const confirmArchive = useClientSettings((settings) => settings.confirmThreadArchive);
  const confirmDelete = useClientSettings((settings) => settings.confirmThreadDelete);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const { copyToClipboard } = useCopyToClipboard<{ title: string; value: string }>({
    onCopy: ({ title, value }) => toastManager.add({ type: "success", title, description: value }),
    onError: (error) =>
      toastManager.add({
        type: "error",
        title: "Could not copy",
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
  });

  const refOf = (task: TaskNode) => scopeThreadRef(task.thread.environmentId, task.thread.id);
  const canOperate = (task: TaskNode) =>
    readEnvironmentScope(task.thread.environmentId, AuthOrchestrationOperateScope);

  const settle = async (task: TaskNode) =>
    reportFailure("Could not mark the task done", await threadActions.settleThread(refOf(task)));
  const unsettle = async (task: TaskNode) =>
    reportFailure("Could not reopen the task", await threadActions.unsettleThread(refOf(task)));

  /** Moving a task changes what its status means, where that is the user's call. */
  const moveTask = async (task: TaskNode, status: TaskStatus) => {
    if (status === task.status || !canOperate(task)) return;
    if (status === "done") {
      await settle(task);
      return;
    }
    if (task.status === "done") await unsettle(task);
    if (status === "proposed") {
      reportFailure(
        "Could not move the task to Proposed",
        await setTag({
          environmentId: task.thread.environmentId,
          input: { threadId: task.thread.id, tag: PROPOSAL_TAG as ThreadTag, tagged: true },
        }),
      );
    }
    if (status === "proposed" && task.thread.interactionMode !== "plan") {
      reportFailure(
        "Could not move the task to Proposed",
        await setInteractionMode({
          environmentId: task.thread.environmentId,
          input: { threadId: task.thread.id, interactionMode: "plan" },
        }),
      );
    }
  };

  const snoozePresetsOf = (task: TaskNode) =>
    resolveSnoozePresets(new Date(), timestampFormat, task.thread.environmentId);

  const snooze = async (task: TaskNode, presetId: string) => {
    const preset =
      presetId === "custom"
        ? await requestCustomSnooze()
        : pickSnoozePreset(
            snoozePresetsOf(task),
            presetId,
            timestampFormat,
            task.thread.environmentId,
          );
    if (!preset) return;
    reportFailure(
      "Could not snooze the task",
      await threadActions.snoozeThread(refOf(task), preset.snoozedUntil),
    );
  };

  const commitRename = async (task: TaskNode, title: string) => {
    setRenamingKey(null);
    const trimmed = title.trim();
    if (trimmed === "" || trimmed === task.thread.title) return;
    reportFailure(
      "Could not rename the task",
      await updateMetadata({
        environmentId: task.thread.environmentId,
        input: { threadId: task.thread.id, title: trimmed },
      }),
    );
  };

  const menuItems = (task: TaskNode): ReadonlyArray<ContextMenuItem<TaskMenuId>> => {
    const config = serverConfigs.get(task.thread.environmentId);
    const loaded = config !== undefined;
    const now = new Date().toISOString();
    const statusMenu: ContextMenuItem<TaskMenuId> = {
      id: "status",
      label: "Status",
      icon: "circle-check",
      children: TASK_STATUSES.filter((status) => status !== "snoozed").map((status) => ({
        id: `status:${status}` as const,
        label: TASK_STATUS_LABELS[status],
        checked: task.status === status,
        disabled: task.status === status || !SETTABLE_TASK_STATUSES.has(status),
      })),
    };
    return [
      statusMenu,
      ...relabelForTasks(
        buildThreadActionMenuItems({
          canOperate: canOperate(task),
          branch: task.thread.branch ?? null,
          projectFilter: null,
          isPinned: task.thread.pinnedAt != null,
          isSettled: task.thread.settledOverride === "settled",
          autoSettleEnabled: task.thread.autoSettleDisabledAt == null,
          isSnoozed: task.status === "snoozed",
          canSnoozeNow: canSnooze(task.thread, { now }),
          isRegeneratingTitle: task.thread.titleRegeneration != null,
          isRunning: !threadRuntimeCanArchive(task.thread.runtime),
          supports: {
            settlement: false,
            autoSettleOptOut: config?.environment.capabilities.threadAutoSettleOptOut === true,
            snooze: loaded,
            pinning: loaded,
            titleRegeneration: loaded,
          },
          snoozePresets: snoozePresetsOf(task),
        }),
      ),
    ];
  };

  const runMenuAction = async (task: TaskNode, id: TaskMenuId) => {
    const threadRef = refOf(task);
    if (id.startsWith("status:")) {
      await moveTask(task, id.slice("status:".length) as TaskStatus);
      return;
    }
    const action = id as ThreadActionMenuId;
    if (threadActionRequiresOperate(action) && !canOperate(task)) return;
    if (action.startsWith("snooze:")) {
      await snooze(task, action.slice("snooze:".length));
      return;
    }
    const path = task.thread.worktreePath;
    switch (action) {
      case "new-thread-on-branch":
        await handleNewThread(scopeProjectRef(task.thread.environmentId, task.thread.projectId), {
          branch: task.thread.branch,
          worktreePath: task.thread.worktreePath,
          envMode: task.thread.worktreePath ? "worktree" : "local",
          startFromOrigin: false,
        });
        return;
      case "project-settings": {
        const projects = readProjects();
        const project = projects.find(
          (candidate) =>
            candidate.environmentId === task.thread.environmentId &&
            candidate.id === task.thread.projectId,
        );
        if (!project) return;
        const projectKey = buildPhysicalToLogicalProjectKeyMap({
          projects,
          settings: selectProjectGroupingSettings(getClientSettings()),
          primaryEnvironmentId: null,
        }).get(derivePhysicalProjectKey(project));
        if (projectKey) await navigate({ to: "/projects/$projectKey", params: { projectKey } });
        return;
      }
      case "pin":
        reportFailure("Could not pin the task", await threadActions.pinThread(threadRef));
        return;
      case "unpin":
        reportFailure("Could not unpin the task", await threadActions.unpinThread(threadRef));
        return;
      case "unsnooze":
        reportFailure("Could not wake the task", await threadActions.unsnoozeThread(threadRef));
        return;
      case "auto-settle:enabled":
      case "auto-settle:disabled":
        reportFailure(
          "Could not change auto-settle",
          await threadActions.setThreadAutoSettle(threadRef, action === "auto-settle:enabled"),
        );
        return;
      case "rename":
        setRenamingKey(task.key);
        return;
      case "regenerate-title":
        reportFailure(
          "Could not regenerate the title",
          await updateMetadata({
            environmentId: task.thread.environmentId,
            input: { threadId: task.thread.id, regenerateTitle: true },
          }),
        );
        return;
      case "mark-unread":
        threadActions.markThreadUnread(threadRef);
        return;
      case "copy-path":
        if (path) copyToClipboard(path, { title: "Path copied", value: path });
        return;
      case "copy-branch":
        if (task.thread.branch) {
          copyToClipboard(task.thread.branch, {
            title: "Branch copied",
            value: task.thread.branch,
          });
        }
        return;
      case "copy-thread":
        void copyThreadReference(
          threadChipCopyTarget(threadRef, task.thread.title, configuredHostedAppUrl()),
        );
        return;
      case "copy-thread-id":
        copyToClipboard(task.thread.id, { title: "Thread ID copied", value: task.thread.id });
        return;
      case "archive":
      case "delete": {
        const api = readLocalApi();
        const confirm = action === "archive" ? confirmArchive : confirmDelete;
        if (confirm && api) {
          const confirmed = await settlePromise(() =>
            api.dialogs.confirm(
              action === "archive"
                ? `Archive task "${task.thread.title}"?`
                : `Delete task "${task.thread.title}"?\nThis permanently clears its conversation history.`,
              action === "delete" ? { variant: "destructive" } : undefined,
            ),
          );
          if (confirmed._tag === "Failure" || !confirmed.value) return;
        }
        reportFailure(
          action === "archive" ? "Could not archive the task" : "Could not delete the task",
          action === "archive"
            ? await threadActions.archiveThread(threadRef)
            : await threadActions.deleteThread(threadRef),
        );
        return;
      }
      default:
        return;
    }
  };

  const openMenu = async (task: TaskNode, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const clicked = await settlePromise(() => api.contextMenu.show(menuItems(task), position));
    if (clicked._tag === "Failure" || clicked.value === null) return;
    await runMenuAction(task, clicked.value);
  };

  /** Snooze choices alone, for a card's clock button. */
  const openSnoozeMenu = async (task: TaskNode, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api) return;
    const presets = snoozePresetsOf(task);
    const items: ReadonlyArray<ContextMenuItem<TaskMenuId>> =
      task.status === "snoozed"
        ? [{ id: "unsnooze", label: "Wake task", icon: "clock" }]
        : [
            ...presets.map((preset) => ({
              id: `snooze:${preset.id}` as const,
              label: `${preset.label} (${preset.whenLabel})`,
            })),
            { id: "snooze:custom", label: "Custom…", separatorBefore: presets.length > 0 },
          ];
    const clicked = await settlePromise(() => api.contextMenu.show(items, position));
    if (clicked._tag === "Failure" || clicked.value === null) return;
    await runMenuAction(task, clicked.value);
  };

  return {
    moveTask,
    openSnoozeMenu,
    settle,
    unsettle,
    openMenu,
    canOperate,
    rename: {
      renamingKey,
      start: (task: TaskNode) => setRenamingKey(task.key),
      commit: commitRename,
      cancel: () => setRenamingKey(null),
    },
  };
}

export type TaskActions = ReturnType<typeof useTaskActions>;
