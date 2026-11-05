import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { threadFamilies } from "../../state/threads";

const FAMILY_KEY_SEPARATOR = "\u0000";

/**
 * Keeps each open task's family loaded. The server leaves finished subagent threads out of the
 * shell, so without this a task's finished subtasks disappear after a reload.
 */
export function useTaskFamilies(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const familyKeys = [
    ...new Set(
      threads
        .filter(
          (thread) =>
            thread.archivedAt === null &&
            thread.settledOverride !== "settled" &&
            thread.lineage.parentThreadId === null,
        )
        .map((thread) => `${thread.environmentId}${FAMILY_KEY_SEPARATOR}${thread.id}`),
    ),
  ]
    .toSorted()
    .join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mounts the families of open tasks into the shared thread registry while the task views show them
  useEffect(() => {
    if (familyKeys === "") return;
    const releases = familyKeys.split("\n").map((key) => {
      const [environmentId, threadId] = key.split(FAMILY_KEY_SEPARATOR) as [
        EnvironmentId,
        ThreadId,
      ];
      return threadFamilies.mount(appAtomRegistry, environmentId, threadId);
    });
    return () => {
      for (const release of releases) release();
    };
  }, [familyKeys]);
}
