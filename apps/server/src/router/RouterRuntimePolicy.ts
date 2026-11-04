import { ROUTER_TAG } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";

export function isRouterThread(thread: { readonly tags?: ReadonlyArray<string> | undefined }) {
  return thread.tags?.includes(ROUTER_TAG) === true;
}

/**
 * The router only reads and delegates. Its own turns run read-only and never ask for approval,
 * while its runtime mode stays as set, because the threads it launches cannot run broader than
 * it does. The sandbox and approval policy are Codex's; other providers ignore them, so there the
 * router's instructions are the only limit.
 */
export const layer: Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RouterRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        if (!isRouterThread(input.thread)) return policy;
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
        });
      }),
    });
  }),
);
