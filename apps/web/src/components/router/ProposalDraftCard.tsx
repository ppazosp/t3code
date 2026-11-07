import type { DraftId } from "../../composerDraftStore";
import { useNavigate } from "@tanstack/react-router";
import { LightbulbIcon } from "lucide-react";

import { Button } from "../ui/button";
import { useProposalDraft } from "./proposalDrafts";
import { useProposalActions, useProposals } from "./RouterSection";

/**
 * Shown above a draft that is a proposal: what the router suggested, and Discard. The composer
 * below carries its brief and settings; sending it accepts the proposal and starts the worker.
 */
export function ProposalDraftCard({ draftId }: { draftId: DraftId | null }) {
  const navigate = useNavigate();
  const { environmentId, proposals } = useProposals();
  const actions = useProposalActions();
  const entry = useProposalDraft(draftId);
  const task = entry === undefined ? undefined : proposals.find((item) => item.id === entry.taskId);
  if (environmentId === null || task === undefined) return null;

  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-border bg-card p-4">
      <LightbulbIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Proposed by the router</span>
        <span className="text-sm font-medium">{task.title}</span>
        <span className="text-xs text-muted-foreground">
          Change the brief, model, effort, plan mode or workspace below, then send to start the
          worker in this chat.
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          if (await actions.discard(environmentId, task)) await navigate({ to: "/" });
        }}
      >
        Discard
      </Button>
    </div>
  );
}
