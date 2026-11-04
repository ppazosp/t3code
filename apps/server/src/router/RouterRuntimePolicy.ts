import { type ProviderInteractionMode, ROUTER_TAG, type RuntimeMode } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";

export function isRouterThread(thread: { readonly tags?: ReadonlyArray<string> | undefined }) {
  return thread.tags?.includes(ROUTER_TAG) === true;
}

/**
 * What the router may start: a plan, whatever it was told, in a mode that writes only inside its
 * workspace. The router reads channel messages anyone can write, so nothing it starts runs until
 * the user approves the plan and picks the mode to implement it in.
 */
export function capRouterLimits<
  Limits extends {
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  },
>(thread: { readonly tags?: ReadonlyArray<string> | undefined }, limits: Limits): Limits {
  return isRouterThread(thread)
    ? { ...limits, runtimeMode: "auto-accept-edits", interactionMode: "plan" }
    : limits;
}

/**
 * The router only reads and delegates. Its own turns run read-only and never ask for approval,
 * and T3's tools, its real work, run without asking. The sandbox and approval policy are Codex's; other providers ignore them, so there the
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
          approveT3Tools: true,
        });
      }),
    });
  }),
);
