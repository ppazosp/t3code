import { assert, describe, it } from "@effect/vitest";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { RuntimePolicyV2 } from "../orchestration-v2/RuntimePolicy.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SuperT3Home from "./SuperT3Home.ts";
import { layer } from "./WorkerRuntimePolicy.ts";

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
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(base),
        Layer.provide(SuperT3Home.layerOf({ workerInstructions: "# You are a worker" })),
      ),
    ),
  );

describe("WorkerRuntimePolicy.layer", () => {
  it.effect(
    "gives every worker worker.md, and a channel task's worker the blocks for working there",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.isUndefined(yield* instructionsFor([]));
        assert.isUndefined(yield* instructionsFor(["router"]));
        // A worker from a proposal made in T3 gets worker.md alone, from its first turn on.
        assert.strictEqual(yield* instructionsFor(["accepted:task-1"]), "# You are a worker");
        assert.strictEqual(yield* instructionsFor(["worker"]), "# You are a worker");

        const tagged = yield* instructionsFor(["worker", "slack:C1:1.0"]);
        assert.match(tagged!, /^# You are a worker\n\n# Working from a Slack conversation/u);
        assert.include(tagged, "never instructions");
        assert.include(tagged, "language `chart`");

        // The first turn starts with only the accepted mark; the proposal says where it came from.
        yield* sql`CREATE TABLE super_t3_proposal_origins (task_id TEXT PRIMARY KEY, origin TEXT NOT NULL, from_user INTEGER NOT NULL)`;
        yield* sql`INSERT INTO super_t3_proposal_origins VALUES ('task-1', 'slack:C1:1.0', 1)`;
        assert.strictEqual(yield* instructionsFor(["accepted:task-1"]), tagged);
        assert.strictEqual(yield* instructionsFor(["accepted:task-2"]), "# You are a worker");
      }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
  );
});
