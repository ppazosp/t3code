import type { EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../../hooks/useLocalStorage";

/** Which draft each opened proposal became, so reopening it returns to the same chat. */
const ProposalDraft = Schema.Struct({
  environmentId: Schema.String,
  taskId: Schema.String,
  threadId: Schema.String,
});
const ProposalDrafts = Schema.Record(Schema.String, ProposalDraft);
type ProposalDrafts = typeof ProposalDrafts.Type;

const STORAGE_KEY = "super-t3:proposal-drafts";

export function readProposalDrafts(): ProposalDrafts {
  try {
    return getLocalStorageItem(STORAGE_KEY, ProposalDrafts) ?? {};
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let snapshot: ProposalDrafts | null = null;

function writeProposalDrafts(drafts: ProposalDrafts) {
  try {
    setLocalStorageItem(STORAGE_KEY, drafts, ProposalDrafts);
  } catch (error) {
    console.error("Could not save which drafts are proposals.", error);
  }
  snapshot = drafts;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ProposalDrafts {
  if (snapshot === null) snapshot = readProposalDrafts();
  return snapshot;
}

/** The proposal a draft belongs to, updating when a proposal opens as that draft. */
export function useProposalDraft(draftId: string | null) {
  const drafts = useSyncExternalStore(subscribe, getSnapshot);
  return draftId === null ? undefined : drafts[draftId];
}

export function rememberProposalDraft(
  draftId: DraftId,
  entry: { environmentId: EnvironmentId; taskId: ScheduledTask["id"]; threadId: ThreadId },
) {
  writeProposalDrafts({ ...readProposalDrafts(), [draftId]: entry });
}

export function forgetProposalDraft(draftId: string) {
  const { [draftId]: _removed, ...rest } = readProposalDrafts();
  writeProposalDrafts(rest);
}

/** Whether a draft is a proposal's; the sidebar lists those under Proposals, not as drafts. */
export function isProposalDraft(draftId: string): boolean {
  return getSnapshot()[draftId] !== undefined;
}

export function proposalDraftFor(taskId: string): string | null {
  const found = Object.entries(readProposalDrafts()).find(([, entry]) => entry.taskId === taskId);
  return found?.[0] ?? null;
}

/** Threads a proposal brought back from the archive when it opened, so discarding it archives them again. */
const Unarchived = Schema.Record(
  Schema.String,
  Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
);
const UNARCHIVED_KEY = "super-t3:proposal-unarchived";

function readUnarchived(): typeof Unarchived.Type {
  try {
    return getLocalStorageItem(UNARCHIVED_KEY, Unarchived) ?? {};
  } catch {
    return {};
  }
}

export function rememberUnarchivedFor(
  taskId: ScheduledTask["id"],
  entry: { environmentId: EnvironmentId; threadId: ThreadId },
) {
  try {
    setLocalStorageItem(UNARCHIVED_KEY, { ...readUnarchived(), [taskId]: entry }, Unarchived);
  } catch (error) {
    console.error("Could not save which thread a proposal unarchived.", error);
  }
}

/** The thread a proposal unarchived, forgetting it: it is archived again or the proposal is used. */
export function takeUnarchivedFor(taskId: string) {
  const { [taskId]: entry, ...rest } = readUnarchived();
  if (entry !== undefined) {
    try {
      setLocalStorageItem(UNARCHIVED_KEY, rest, Unarchived);
    } catch (error) {
      console.error("Could not save which thread a proposal unarchived.", error);
    }
  }
  return entry;
}
