import { PROPOSAL_TAG, type ThreadTag } from "@t3tools/contracts";
import { useState } from "react";

import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import type { TaskNode } from "./tasks.logic";

const APPROVAL_MESSAGE = "The user approved your plan. Implement it now.";

const nowIso = () => new Date().toISOString();

/**
 * A proposal waits for approval once its worker has stopped: with a plan, or with a question or
 * a report instead of one. Approving it is the only way it starts work.
 */
export function canApproveTask(task: TaskNode): boolean {
  return (
    task.status === "proposed" &&
    (task.thread.hasActionableProposedPlan || task.thread.latestRun !== null) &&
    (task.thread.runtime === null ||
      !["preparing", "queued", "starting", "running", "waiting"].includes(
        task.thread.runtime.status,
      ))
  );
}

/**
 * Approves a proposed task's plan from the board, which works whether or not the plan follow-up
 * is enabled in the chat. Approved work runs with full access, so it can push and use the network.
 */
export function TaskApproveButton({ task }: { task: TaskNode }) {
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode);
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode);
  const setTag = useOrchestrationCommand(threadEnvironment.setTag);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const [approving, setApproving] = useState(false);
  const { environmentId, id: threadId } = task.thread;

  const approve = async () => {
    if (approving) return;
    setApproving(true);
    const runtimeMode = "full-access";
    const steps = [
      // Approval lifts the proposal's limits: it may now delegate and message other threads.
      () =>
        setTag({
          environmentId,
          input: { threadId, tag: PROPOSAL_TAG as ThreadTag, tagged: false },
        }),
      () => setRuntimeMode({ environmentId, input: { threadId, runtimeMode } }),
      () => setInteractionMode({ environmentId, input: { threadId, interactionMode: "default" } }),
      () =>
        startTurn({
          environmentId,
          input: {
            threadId,
            message: {
              messageId: newMessageId(),
              role: "user",
              text: APPROVAL_MESSAGE,
              attachments: [],
            },
            runtimeMode,
            interactionMode: "default",
            dispatchMode: "auto",
            createdAt: nowIso(),
          },
        }),
    ];
    for (const step of steps) {
      if ((await step())._tag === "Failure") break;
    }
    setApproving(false);
  };

  return (
    <Button size="xs" className="relative z-10" disabled={approving} onClick={() => void approve()}>
      {approving ? "Approving…" : "Approve"}
    </Button>
  );
}
