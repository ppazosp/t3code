import { type ProviderInteractionMode, ROUTER_TAG, type RuntimeMode } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { isProposalThread } from "./RouterProposals.ts";

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

/** The router's T3 tools: read anything, propose tasks, and answer the user in a channel. */
export const ROUTER_TOOLS: ReadonlyArray<string> = [
  "orchestrator_capabilities",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_launch",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "list_scheduled_tasks",
  "channel_reply",
];

/**
 * The router only reads and delegates, and a proposal only reads and plans until it is approved.
 * Both run read-only and never ask for approval; the router also gets only the T3 tools it needs,
 * which run without asking. The sandbox and approval policy are Codex's; other providers ignore
 * them, so there the instructions and T3's tool checks are the only limits.
 */
export const layer: Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2> = Layer.effect(
  RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicyV2;
    return RuntimePolicyV2.of({
      resolve: Effect.fn("RouterRuntimePolicy.resolve")(function* (input) {
        const policy = yield* base.resolve(input);
        // A proposal reads and plans; plan mode alone does not stop Codex from editing its worktree.
        if (isProposalThread(input.thread) && !isRouterThread(input.thread)) {
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
          });
        }
        if (!isRouterThread(input.thread)) return policy;
        return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...policy,
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly" },
          t3ToolAllowlist: ROUTER_TOOLS,
        });
      }),
    });
  }),
);
