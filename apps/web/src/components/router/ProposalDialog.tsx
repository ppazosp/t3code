import { useAtomValue } from "@effect/atom-react";
import {
  PROPOSAL_RUN_AT,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ProjectId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type SelectProviderOptionDescriptor,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolvePastedPath } from "@t3tools/shared/path";
import {
  BotIcon,
  FolderIcon,
  FolderOpenIcon,
  FolderTreeIcon,
  GaugeIcon,
  GitBranchIcon,
  LightbulbIcon,
  ListChecksIcon,
  PlayIcon,
  ShieldIcon,
  XIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { providerInstanceEntriesFor } from "../../providerInstances";
import { useProjects } from "../../state/entities";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import type { ProposalActions } from "./RouterSection";

type WorkspaceMode = OrchestrationV2ThreadLaunchWorkspaceStrategy["type"];

const WORKSPACE_LABELS: Record<WorkspaceMode, string> = {
  worktree: "A new worktree",
  root: "The project's folder",
  existing_worktree: "Another folder",
};

/** The model's reasoning control, such as Codex's effort, if it has one. */
function effortDescriptorOf(
  providers: ReadonlyArray<ServerProvider>,
  selection: ModelSelection,
): SelectProviderOptionDescriptor | null {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((entry) => entry.slug === selection.model);
  for (const descriptor of model?.capabilities?.optionDescriptors ?? []) {
    if (
      descriptor.type === "select" &&
      (descriptor.role === "reasoning" || descriptor.id === "reasoningEffort")
    ) {
      return descriptor;
    }
  }
  return null;
}

/**
 * A proposal, as the router set it up: what to do, where, and with which model. Everything can be
 * changed before accepting; accepting saves the changes and starts the worker.
 */
export function ProposalDialog({
  environmentId,
  task,
  actions,
  onClose,
}: {
  environmentId: EnvironmentId;
  task: ScheduledTask;
  actions: ProposalActions;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.prompt);
  const [projectId, setProjectId] = useState<ProjectId>(task.projectId);
  const [workspace, setWorkspace] = useState(task.workspaceStrategy);
  const [selection, setSelection] = useState<ModelSelection>(task.modelSelection);
  const [plan, setPlan] = useState(task.interactionMode === "plan");

  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const project = projects.find((entry) => entry.id === projectId);
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection.instanceId,
    selection.model,
  );
  const effort = effortDescriptorOf(providers, selection);
  const effortValue = selection.options?.find((option) => option.id === effort?.id)?.value;
  const upsert = useAtomCommand(serverEnvironment.upsertScheduledTask, {
    label: "proposal save",
  });

  const save = async () => {
    const input: ScheduledTaskUpsertInput = {
      id: task.id,
      requireExisting: true,
      title: title.trim() || task.title,
      prompt: brief.trim() || task.prompt,
      enabled: false,
      schedule: { type: "once", runAt: PROPOSAL_RUN_AT },
      projectId,
      workspaceStrategy: workspace,
      modelSelection: selection,
      runtimeMode: task.runtimeMode,
      interactionMode: plan ? "plan" : "default",
      creationSource: "web",
    };
    const result = await upsert({ environmentId, input });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not save the proposal" });
      return false;
    }
    return true;
  };
  const act = async (step: () => Promise<boolean>) => {
    setBusy(true);
    const done = await step();
    setBusy(false);
    if (done) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <LightbulbIcon aria-hidden className="size-4" />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <DialogDescription>Proposed by the router</DialogDescription>
              <DialogTitle className="sr-only">{title}</DialogTitle>
              <input
                aria-label="Title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="w-full rounded-md bg-transparent text-lg font-semibold text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            </div>
          </div>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <Textarea
              aria-label="Brief"
              className="max-h-56 overflow-y-auto"
              value={brief}
              onChange={(event) => setBrief(event.target.value)}
            />
            <div className="flex flex-col divide-y divide-border rounded-xl border border-border">
              <SettingRow icon={<FolderIcon />} label="Project">
                <Select
                  value={projectId}
                  onValueChange={(value) => setProjectId(value as ProjectId)}
                >
                  <SelectTrigger size="sm" aria-label="Project">
                    <SelectValue>{project?.title ?? "Choose a project"}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {projects.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {entry.title}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </SettingRow>
              <SettingRow icon={<FolderTreeIcon />} label="Runs in">
                <Select
                  value={workspace.type}
                  onValueChange={(value) =>
                    setWorkspace(
                      value === "worktree"
                        ? { type: "worktree", baseRef: "main" }
                        : value === "root"
                          ? { type: "root" }
                          : {
                              type: "existing_worktree",
                              worktreePath: project?.workspaceRoot ?? "/",
                            },
                    )
                  }
                >
                  <SelectTrigger size="sm" aria-label="Runs in">
                    <SelectValue>{WORKSPACE_LABELS[workspace.type]}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(Object.keys(WORKSPACE_LABELS) as Array<WorkspaceMode>).map((mode) => (
                      <SelectItem key={mode} value={mode}>
                        {WORKSPACE_LABELS[mode]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </SettingRow>
              {workspace.type === "worktree" ? (
                <SettingRow icon={<GitBranchIcon />} label="Base branch">
                  <WorktreeBaseBranchPicker
                    key={`${environmentId}:${projectId}`}
                    environmentId={environmentId}
                    cwd={project?.workspaceRoot ?? null}
                    value={workspace.baseRef}
                    onValueChange={(baseRef) => setWorkspace({ ...workspace, baseRef })}
                    startFromOrigin={workspace.startFromOrigin ?? false}
                    onStartFromOriginChange={(startFromOrigin) =>
                      setWorkspace({ ...workspace, startFromOrigin })
                    }
                    disabled={busy}
                  />
                </SettingRow>
              ) : null}
              {workspace.type === "existing_worktree" ? (
                <SettingRow icon={<FolderOpenIcon />} label="Folder">
                  <Input
                    aria-label="Folder"
                    value={workspace.worktreePath}
                    onChange={(event) =>
                      setWorkspace({
                        type: "existing_worktree",
                        worktreePath:
                          resolvePastedPath(workspace.worktreePath, event.target.value) || "/",
                      })
                    }
                  />
                </SettingRow>
              ) : null}
              <SettingRow icon={<BotIcon />} label="Model">
                <ProviderModelPicker
                  environmentId={environmentId}
                  disabled={busy}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={instanceEntries}
                  modelOptionsByInstance={modelOptionsByInstance}
                  isComposerOwned={false}
                  triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                  onInstanceModelChange={(instanceId, model) => setSelection({ instanceId, model })}
                />
              </SettingRow>
              {effort === null ? null : (
                <SettingRow icon={<GaugeIcon />} label="Effort">
                  <Select
                    value={typeof effortValue === "string" ? effortValue : ""}
                    onValueChange={(value) =>
                      setSelection({
                        ...selection,
                        options: [
                          ...(selection.options ?? []).filter((option) => option.id !== effort.id),
                          { id: effort.id, value: value as string },
                        ],
                      })
                    }
                  >
                    <SelectTrigger size="sm" aria-label="Effort">
                      <SelectValue>
                        {effort.options.find((option) => option.id === effortValue)?.label ??
                          "Default"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {effort.options.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </SettingRow>
              )}
              <SettingRow
                icon={<ListChecksIcon />}
                label="Start with a plan"
                hint="The worker plans first and waits for you"
              >
                <Switch aria-label="Start with a plan" checked={plan} onCheckedChange={setPlan} />
              </SettingRow>
              <SettingRow
                icon={<ShieldIcon />}
                label="Access"
                hint="Accepted work can push and use the network"
              >
                <span className="text-sm text-muted-foreground">Full access</span>
              </SettingRow>
            </div>
          </div>
        </DialogPanel>
        <DialogFooter>
          <div className="flex w-full items-center justify-between gap-2">
            <Button
              variant="ghost-destructive"
              size="sm"
              disabled={busy}
              onClick={() => void act(() => actions.discard(environmentId, task))}
            >
              <XIcon />
              Discard
            </Button>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={busy} onClick={() => void act(save)}>
                Save
              </Button>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void act(async () => (await save()) && actions.accept(environmentId, task))
                }
              >
                <PlayIcon />
                Accept
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** One setting of a proposal: its icon and name on the left, its control on the right. */
function SettingRow({
  icon,
  label,
  hint,
  children,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-3.5 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
          {icon}
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-sm font-medium">{label}</span>
          {hint === undefined ? null : (
            <span className="text-xs text-muted-foreground">{hint}</span>
          )}
        </div>
      </div>
      <div className="flex w-60 shrink-0 justify-end">{children}</div>
    </div>
  );
}
