import { readProposalSource } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { LightbulbIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { useProposalDraft } from "./proposalDrafts";
import { SourceIcon } from "./SourceIcon";
import { useProposalActions, useProposals } from "./RouterSection";

/**
 * A tab on top of a proposal's composer: what the router proposed, where it came from (with the
 * message itself), and Discard. The composer under it holds the brief and settings; sending it
 * accepts the proposal. Any other draft shows `fallback`, T3's own headline.
 */
export function ProposalComposerTab({
  draftId,
  fallback,
}: {
  draftId: DraftId | null;
  fallback: ReactNode;
}) {
  const navigate = useNavigate();
  const { environmentId, proposals } = useProposals();
  const actions = useProposalActions();
  const entry = useProposalDraft(draftId);
  const task = entry === undefined ? undefined : proposals.find((item) => item.id === entry.taskId);
  if (environmentId === null || task === undefined) return fallback;
  const { source } = readProposalSource(task.prompt);

  return (
    // Tucked under the composer's top edge, so the two read as one piece.
    <div className="mx-3.5 -mb-4 rounded-t-2xl border border-b-0 border-border bg-card px-4 pt-3 pb-6">
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <LightbulbIcon aria-hidden className="size-3.5 shrink-0 text-primary" />
        <span className="font-medium text-primary">Proposal</span>
        {source === null ? null : (
          <>
            <span aria-hidden>·</span>
            <SourceIcon kind={source.kind} className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {source.where} · {source.author} · <RelativeTime timestamp={source.at} />
            </span>
          </>
        )}
        <Button
          size="xs"
          variant="ghost-muted"
          className="ml-auto"
          onClick={async () => {
            if (await actions.discard(environmentId, task)) await navigate({ to: "/" });
          }}
        >
          <XIcon />
          Discard
        </Button>
      </div>
      <p className="mt-1 text-base font-semibold text-foreground">{task.title}</p>
      {source === null || source.text === "" ? null : (
        <blockquote className="mt-2 line-clamp-3 border-l-2 border-border pl-3 text-sm text-muted-foreground">
          {source.text}
        </blockquote>
      )}
    </div>
  );
}
