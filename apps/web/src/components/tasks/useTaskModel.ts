import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { Atom } from "effect/reactivity";

import { getTriggerDisplayModelName } from "../chat/providerIconUtils";
import { deriveProviderEntriesByEnvironment } from "../../providerInstances";
import { environmentPresentations } from "../../state/presentation";

// Per environment, as in the thread sidebar: default instance ids collide across environments.
const providerEntriesAtom = Atom.make((get) => {
  const providersByEnvironment = get(environmentPresentations.providersByEnvironmentAtom);
  return deriveProviderEntriesByEnvironment(
    [...get(environmentPresentations.serverConfigsAtom)].map(
      ([environmentId, config]) =>
        [environmentId, providersByEnvironment.get(environmentId) ?? [], config.settings] as const,
    ),
  );
}).pipe(Atom.withLabel("task-provider-entries"));

/** The model a thread runs on, named as the composer's model picker names it. */
export function useTaskModel(thread: EnvironmentThreadShell) {
  const entriesByEnvironment = useAtomValue(providerEntriesAtom);
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const provider = entriesByEnvironment.get(thread.environmentId)?.get(instanceId) ?? null;
  const model = provider?.models.find((entry) => entry.slug === thread.modelSelection.model);
  return {
    provider,
    label:
      model === undefined
        ? thread.modelSelection.model
        : getTriggerDisplayModelName(model, provider?.driverKind),
  };
}
