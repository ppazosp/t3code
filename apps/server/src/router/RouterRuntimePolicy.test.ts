import { assert, describe, it } from "@effect/vitest";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { layer } from "./RouterRuntimePolicy.ts";
import * as SuperT3Home from "./SuperT3Home.ts";

describe("RouterRuntimePolicy.layer", () => {
  const base = Layer.succeed(RuntimePolicyV2, {
    resolve: () =>
      Effect.succeed(
        ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto-accept-edits",
          interactionMode: "plan",
          cwd: null,
        }),
      ),
  });
  const resolve = (tags: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicyV2;
      return yield* policy.resolve({
        thread: { id: "thread:a", tags } as never,
        modelSelection: { instanceId: "codex", model: "m" } as never,
      });
    }).pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(base),
          Layer.provide(SuperT3Home.layerOf({ routerInstructions: "# You are the router" })),
        ),
      ),
    );

  it.effect("runs the router read-only, with only its own T3 tools", () =>
    Effect.gen(function* () {
      const policy = yield* resolve(["router"]);
      assert.deepStrictEqual(policy.sandboxPolicy, { type: "readOnly" });
      assert.strictEqual(policy.approvalPolicy, "never");
      assert.include(policy.t3ToolAllowlist ?? [], "propose_task");
      assert.notInclude(policy.t3ToolAllowlist ?? [], "t3_thread_launch");
      // router.md is its system prompt, and it works in an empty folder of its own.
      assert.strictEqual(policy.instructions, "# You are the router");
      assert.strictEqual(policy.cwd, "/super-t3/router");
    }),
  );

  it.effect("leaves every other thread's policy as the project sets it", () =>
    Effect.gen(function* () {
      const policy = yield* resolve([]);
      assert.isUndefined(policy.sandboxPolicy);
    }),
  );
});
