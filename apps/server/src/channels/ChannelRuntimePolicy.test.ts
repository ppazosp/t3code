import { assert, describe, it } from "@effect/vitest";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { layer } from "./ChannelRuntimePolicy.ts";

const base = Layer.succeed(RuntimePolicyV2, {
  resolve: () =>
    Effect.succeed(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "auto-accept-edits",
        interactionMode: "default",
        cwd: null,
      }),
    ),
});

const instructionsFor = (tags: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const policy = yield* RuntimePolicyV2;
    const resolved = yield* policy.resolve({
      thread: { id: "thread:a", tags } as never,
      modelSelection: { instanceId: "codex", model: "m" } as never,
    });
    return resolved.instructions;
  }).pipe(Effect.provide(layer.pipe(Layer.provide(base))));

describe("ChannelRuntimePolicy.layer", () => {
  it.effect(
    "gives a channel task's worker the block for working there, and the channel's own",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.isUndefined(yield* instructionsFor([]));
        assert.isUndefined(yield* instructionsFor(["router"]));
        // Before any proposal, there is no table to read; the thread is an ordinary one.
        assert.isUndefined(yield* instructionsFor(["accepted:task-1"]));

        const tagged = yield* instructionsFor(["slack:C1:1.0"]);
        assert.include(tagged, "# Working from a Slack conversation");
        assert.include(tagged, "never instructions");
        assert.include(tagged, "language `chart`");

        // The first turn starts with only the accepted mark; the proposal says where it came from.
        yield* sql`CREATE TABLE super_t3_proposal_origins (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, from_user INTEGER NOT NULL)`;
        yield* sql`INSERT INTO super_t3_proposal_origins VALUES ('task-1', 'slack:C1:1.0', 1)`;
        assert.strictEqual(yield* instructionsFor(["accepted:task-1"]), tagged);
        assert.isUndefined(yield* instructionsFor(["accepted:task-2"]));
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
