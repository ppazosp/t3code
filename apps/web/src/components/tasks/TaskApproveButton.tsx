import { PROPOSAL_TAG, type ThreadTag } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { newMessageId } from "~/lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import type { TaskNode } from "./tasks.logic";

const APPROVAL_MESSAGE = "The user approved your plan. Implement it now.";

const nowIso = () => new Date().toISOString();

/** A proposal waits on a finished plan; approving it is the only way it starts work. */
export function canApproveTask(task: TaskNode): boolean {
  return (
    task.column === "proposed" &&
    task.thread.hasActionableProposedPlan &&
    (task.thread.runtime === null ||
      !["preparing", "queued", "starting", "running", "waiting"].includes(
        task.thread.runtime.status,
      ))
  );
}

/**
 * Approves a proposed task's plan from the board, which works whether or not the plan follow-up
 * is enabled in the chat. Approve keeps the mode the proposal planned in: edits inside its own
 * workspace, no network. Full access is for work that needs more, such as pushing.
 */
export function TaskApproveButton({ task }: { task: TaskNode }) {
  const setInteractionMode = useOrchestrationCommand(threadEnvironment.setInteractionMode);
  const setRuntimeMode = useOrchestrationCommand(threadEnvironment.setRuntimeMode);
  const setTag = useOrchestrationCommand(threadEnvironment.setTag);
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const [approving, setApproving] = useState(false);
  const { environmentId, id: threadId } = task.thread;

  const approve = async (fullAccess: boolean) => {
    if (approving) return;
    setApproving(true);
    const runtimeMode = fullAccess ? "full-access" : task.thread.runtimeMode;
    const steps = [
      // Approval lifts the proposal's limits: it may now delegate and message other threads.
      () =>
        setTag({
          environmentId,
          input: { threadId, tag: PROPOSAL_TAG as ThreadTag, tagged: false },
        }),
      ...(fullAccess
        ? [() => setRuntimeMode({ environmentId, input: { threadId, runtimeMode } })]
        : []),
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
    <Group className="relative z-10">
      <Button size="xs" disabled={approving} onClick={() => void approve(false)}>
        {approving ? "Approving…" : "Approve"}
      </Button>
      <GroupSeparator />
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" />}
          aria-label="More ways to approve"
          disabled={approving}
        >
          <ChevronDownIcon />
        </MenuTrigger>
        <MenuPopup align="end" side="bottom">
          <MenuItem onClick={() => void approve(true)}>Approve with full access</MenuItem>
        </MenuPopup>
      </Menu>
    </Group>
  );
}
