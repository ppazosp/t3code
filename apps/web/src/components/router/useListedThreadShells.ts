import { ROUTER_TAG } from "@t3tools/contracts";

import { useQuietThreadShells } from "../../state/entities";

/** The sidebar's threads without the router, which has its own button above them. */
export function useListedThreadShells() {
  return useQuietThreadShells().filter(
    (thread) => thread.source.tags?.includes(ROUTER_TAG) !== true,
  );
}
