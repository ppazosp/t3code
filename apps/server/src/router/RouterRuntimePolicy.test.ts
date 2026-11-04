import { assert, describe, it } from "@effect/vitest";

import { capRouterLimits } from "./RouterRuntimePolicy.ts";

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
