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
import { useState } from "react";

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
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../settings/settingsLayout";
import { WorktreeBaseBranchPicker } from "../WorktreeBaseBranchPicker";
import type { ProposalActions } from "./ProposalsSection";

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
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Proposal</DialogTitle>
          <DialogDescription>
            The router suggests this work. Change anything, then accept it to start a worker.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proposal-title">Title</Label>
              <Input
                id="proposal-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="proposal-brief">Brief</Label>
              <Textarea
                id="proposal-brief"
                className="max-h-64 overflow-y-auto"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal-project">Project</Label>
                <Select
                  value={projectId}
                  onValueChange={(value) => setProjectId(value as ProjectId)}
                >
                  <SelectTrigger size="sm" id="proposal-project">
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
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal-workspace">Runs in</Label>
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
                  <SelectTrigger size="sm" id="proposal-workspace">
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
              </div>
            </div>
            {workspace.type === "worktree" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal-base-ref">Base branch</Label>
                <WorktreeBaseBranchPicker
                  key={`${environmentId}:${projectId}`}
                  id="proposal-base-ref"
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
              </div>
            ) : null}
            {workspace.type === "existing_worktree" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="proposal-folder">Folder</Label>
                <Input
                  id="proposal-folder"
                  value={workspace.worktreePath}
                  onChange={(event) =>
                    setWorkspace({
                      type: "existing_worktree",
                      worktreePath:
                        resolvePastedPath(workspace.worktreePath, event.target.value) || "/",
                    })
                  }
                />
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <Label>Model</Label>
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
              </div>
              {effort === null ? null : (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="proposal-effort">Effort</Label>
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
                    <SelectTrigger size="sm" id="proposal-effort">
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
                </div>
              )}
            </div>
            <label className="flex items-center justify-between gap-3 text-sm">
              Start with a plan to review
              <Switch checked={plan} onCheckedChange={setPlan} />
            </label>
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => actions.discard(environmentId, task))}
          >
            Discard
          </Button>
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
            Accept
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
