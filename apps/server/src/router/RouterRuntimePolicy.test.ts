import { assert, describe, it } from "@effect/vitest";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import { capRouterLimits, layer } from "./RouterRuntimePolicy.ts";

describe("capRouterLimits", () => {
  const limits = { runtimeMode: "full-access", interactionMode: "default" } as const;

  it("lets the router start only plans that write nowhere but their workspace", () => {
    assert.deepStrictEqual(capRouterLimits({ tags: ["router"] }, limits), {
      runtimeMode: "auto-accept-edits",
      interactionMode: "plan",
    });
  });

  it("leaves every other thread's limits as they are", () => {
    assert.strictEqual(capRouterLimits({ tags: ["other"] }, limits), limits);
    assert.strictEqual(capRouterLimits({}, limits), limits);
  });
});

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
    }).pipe(Effect.provide(layer.pipe(Layer.provide(base))));

  it.effect("runs a proposal read-only, so it cannot edit before approval", () =>
    Effect.gen(function* () {
      const policy = yield* resolve(["proposal"]);
      assert.deepStrictEqual(policy.sandboxPolicy, { type: "readOnly" });
      assert.strictEqual(policy.approvalPolicy, "never");
      assert.isUndefined(policy.t3ToolAllowlist);
    }),
  );

  it.effect("leaves an approved task's policy as the project sets it", () =>
    Effect.gen(function* () {
      const policy = yield* resolve([]);
      assert.isUndefined(policy.sandboxPolicy);
    }),
  );
});
