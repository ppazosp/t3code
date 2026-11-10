import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, BotIcon, LightbulbIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useProject, useThreadShell } from "~/state/entities";
import { SlackIcon } from "../Icons";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import type { RouterAction } from "./routerActions";
import { useOpenProposal, useProposals } from "./RouterSection";

function ActionCard(props: {
  icon: ReactNode;
  label: string;
  title: ReactNode;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border/60 bg-card px-3 py-2.5">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {props.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-xs text-muted-foreground">{props.label}</span>
        <span className="truncate text-sm text-foreground">{props.title}</span>
        {props.detail === undefined ? null : (
          <span className="line-clamp-2 text-xs text-muted-foreground">{props.detail}</span>
        )}
      </div>
      {props.action}
    </div>
  );
}

function ThreadCard(props: {
  environmentId: EnvironmentId;
  threadId: string;
  label: string;
  fallbackTitle: string;
  icon: ReactNode;
}) {
  const threadId = ThreadId.make(props.threadId);
  const shell = useThreadShell({ environmentId: props.environmentId, threadId });
  const project = useProject(shell ? scopeProjectRef(props.environmentId, shell.projectId) : null);
  return (
    <ActionCard
      icon={props.icon}
      label={props.label}
      title={shell?.title?.trim() || props.fallbackTitle}
      {...(project ? { detail: <ProjectLine project={project} /> } : {})}
      action={
        <Button
          size="xs"
          variant="outline"
          render={
            <Link
              to="/$environmentId/$threadId"
              params={{ environmentId: props.environmentId, threadId }}
            />
          }
        >
          Open chat
        </Button>
      }
    />
  );
}

function ProjectLine({ project }: { project: NonNullable<ReturnType<typeof useProject>> }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <ProjectFavicon project={project} className="size-3" />
      <span className="truncate">{project.title}</span>
    </span>
  );
}

function ProposalCard(props: { title: string; proposalId: string }) {
  const { environmentId, proposals } = useProposals();
  const openProposal = useOpenProposal();
  const task = proposals.find((entry) => entry.id === props.proposalId);
  return (
    <ActionCard
      icon={<LightbulbIcon aria-hidden className="size-4" />}
      label="Worker proposed"
      title={props.title}
      {...(task === undefined ? { detail: "Accepted or discarded" } : {})}
      {...(task === undefined || environmentId === null
        ? {}
        : {
            action: (
              <Button
                size="xs"
                variant="outline"
                onClick={() => void openProposal(environmentId, task)}
              >
                Review
              </Button>
            ),
          })}
    />
  );
}

/**
 * What the router did in a turn: the workers it started or proposed, the threads it passed
 * information to, and its channel replies. It ends such turns without text, so this is the reply.
 */
export function RouterActionCards(props: {
  environmentId: EnvironmentId;
  actions: ReadonlyArray<RouterAction>;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {props.actions.map((action, index) => {
        const key = `${action.kind}:${index}`;
        switch (action.kind) {
          case "started":
            return action.threadId === null ? (
              <ActionCard
                key={key}
                icon={<BotIcon aria-hidden className="size-4" />}
                label="Worker dispatched"
                title={action.title}
              />
            ) : (
              <ThreadCard
                key={key}
                environmentId={props.environmentId}
                threadId={action.threadId}
                label="Worker dispatched"
                fallbackTitle={action.title}
                icon={<BotIcon aria-hidden className="size-4" />}
              />
            );
          case "proposed":
            return <ProposalCard key={key} title={action.title} proposalId={action.proposalId} />;
          case "routed":
            return (
              <ThreadCard
                key={key}
                environmentId={props.environmentId}
                threadId={action.threadId}
                label="Passed to a worker"
                fallbackTitle="Worker"
                icon={<ArrowRightIcon aria-hidden className="size-4" />}
              />
            );
          case "replied":
            return (
              <ActionCard
                key={key}
                icon={<SlackIcon aria-hidden className="size-4" />}
                label="Replied in Slack"
                title={action.text}
              />
            );
        }
      })}
    </div>
  );
}
