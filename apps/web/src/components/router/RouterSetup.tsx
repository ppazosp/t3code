import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type ModelSelection, ROUTER_TAG, type ThreadTag } from "@t3tools/contracts";
import { ChevronDownIcon, RouteIcon } from "lucide-react";
import { useState } from "react";

import { newMessageId, newThreadId } from "~/lib/utils";
import { primaryServerProvidersAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";

const ROUTER_TITLE = "Router";
// The server caps what the router starts, whatever its own mode. Its own mode stays narrow too,
// so a provider without a read-only sandbox still asks before the router edits anything.
const ROUTER_RUNTIME_MODE = "approval-required";

const nowIso = () => new Date().toISOString();

function RouterFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border/70 bg-card p-3 shadow-xs/5">
      {children}
    </div>
  );
}

interface ModelOption {
  readonly value: string;
  readonly label: string;
  readonly selection: ModelSelection;
}

export function RouterSetup({ projects }: { projects: ReadonlyArray<EnvironmentProject> }) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const createThread = useOrchestrationCommand(threadEnvironment.create);
  const setTag = useOrchestrationCommand(threadEnvironment.setTag);
  const pin = useOrchestrationCommand(threadEnvironment.pin);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const projectKeyOf = (project: EnvironmentProject) => `${project.environmentId}:${project.id}`;
  const project =
    projects.find((candidate) => projectKeyOf(candidate) === projectKey) ?? projects[0];
  const modelOptions: ModelOption[] = providers
    .filter((provider) => provider.enabled && provider.installed)
    .flatMap((provider) =>
      provider.models.map((model) => ({
        value: `${provider.instanceId}:${model.slug}`,
        label: `${provider.displayName ?? provider.driver} · ${model.name}`,
        selection: { instanceId: provider.instanceId, model: model.slug },
        isDefault: model.isDefault === true,
        isCodex: provider.driver === "codex",
      })),
    )
    // The router's read-only limit is enforced for Codex, so Codex's default comes first.
    .toSorted(
      (left, right) =>
        Number(right.isCodex) - Number(left.isCodex) ||
        Number(right.isDefault) - Number(left.isDefault),
    );
  // The server moves the router to the model in super-t3's config.json once it is tagged.
  const model = modelOptions[0];

  const start = async () => {
    if (project === undefined || model === undefined || starting) return;
    setStarting(true);
    const environmentId = project.environmentId;
    const threadId = newThreadId();
    const createdAt = nowIso();
    // Tag before the first turn, so the router's limits apply from its first word.
    const steps = [
      () =>
        createThread({
          environmentId,
          input: {
            threadId,
            projectId: project.id,
            title: ROUTER_TITLE,
            modelSelection: model.selection,
            runtimeMode: ROUTER_RUNTIME_MODE,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
          },
        }),
      () =>
        setTag({
          environmentId,
          input: { threadId, tag: ROUTER_TAG as ThreadTag, tagged: true },
        }),
      () => pin({ environmentId, input: { threadId } }),
      () =>
        startTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: "You are my router now. Say hello in one line.",
              attachments: [],
            },
            modelSelection: model.selection,
            runtimeMode: ROUTER_RUNTIME_MODE,
            interactionMode: "default",
            createdAt,
          },
        }),
    ];
    for (const step of steps) {
      const result = await step();
      if (result._tag === "Failure") {
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not start the router",
          description: failure instanceof Error ? failure.message : String(failure),
        });
        break;
      }
    }
    setStarting(false);
  };

  return (
    <RouterFrame>
      <div className="flex items-center gap-2 text-sm">
        <RouteIcon aria-hidden className="size-4 text-muted-foreground" />
        <span className="font-medium">Start the router</span>
      </div>
      <p className="text-xs text-muted-foreground">
        The router is one conversation for all your work. It turns requests and channel messages
        into tasks, proposes work for you to approve, and follows each task. It sees only T3, in a
        folder of its own, and runs on the model in super-t3's config.json; the project only lists
        its thread.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Menu>
          <MenuTrigger
            render={<Button variant="outline" size="sm" />}
            disabled={projects.length === 0}
          >
            {project ? <ProjectFavicon project={project} className="size-3.5" /> : null}
            <span className="truncate">{project?.title ?? "No projects"}</span>
            <ChevronDownIcon aria-hidden className="size-3 text-muted-foreground/70" />
          </MenuTrigger>
          <MenuPopup align="start" side="bottom">
            <MenuRadioGroup
              value={project ? projectKeyOf(project) : ""}
              onValueChange={(next) => setProjectKey(next as string)}
            >
              {projects.map((candidate) => (
                <MenuRadioItem key={projectKeyOf(candidate)} value={projectKeyOf(candidate)}>
                  <span className="flex min-w-0 items-center gap-2">
                    <ProjectFavicon project={candidate} className="size-3.5" />
                    {candidate.title}
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </Menu>
        <Button
          size="sm"
          className="ml-auto"
          disabled={project === undefined || model === undefined || starting}
          onClick={() => void start()}
        >
          {starting ? "Starting…" : "Start router"}
        </Button>
      </div>
    </RouterFrame>
  );
}
