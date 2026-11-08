import { ROUTER_TAG } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { SuperT3Home } from "./SuperT3Home.ts";

export function isRouterThread(thread: { readonly tags?: ReadonlyArray<string> | undefined }) {
  return thread.tags?.includes(ROUTER_TAG) === true;
}

/**
 * The router's T3 tools: see which workers there are and what they are doing, propose new ones, and
 * answer the user in a channel. It starts nothing itself.
 */
export const ROUTER_TOOLS: ReadonlyArray<string> = [
  "orchestrator_capabilities",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_search",
  "list_scheduled_tasks",
  "propose_task",
  "route_to_thread",
  "channel_reply",
  "channel_read",
];

/**
 * The router only reads and proposes. It runs read-only in an empty folder, never asks for approval,
 * gets only the T3 tools it needs (Codex and Claude enforce that), and takes ROUTER.md as its system
 * prompt, read on every turn so an edit applies on the next one.
 */
export const layer: Layer.Layer<RuntimePolicyV2, never, RuntimePolicyV2 | SuperT3Home> =
  Layer.effect(
    RuntimePolicyV2,
    Effect.gen(function* () {
      const base = yield* RuntimePolicyV2;
      const home = yield* SuperT3Home;
      return RuntimePolicyV2.of({
        resolve: Effect.fn("RouterRuntimePolicy.resolve")(function* (input) {
          const policy = yield* base.resolve(input);
          if (!isRouterThread(input.thread)) return policy;
          return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            ...policy,
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly" },
            t3ToolAllowlist: ROUTER_TOOLS,
            instructions: yield* home.routerInstructions,
            cwd: home.routerDir,
          });
        }),
      });
    }),
  );
