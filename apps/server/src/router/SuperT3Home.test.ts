import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../config.ts";
import { DEFAULT_WORKER_MD } from "./defaults.ts";
import * as SuperT3Home from "./SuperT3Home.ts";

describe("SuperT3Home", () => {
  it.effect("seeds what is missing, keeps what the user wrote, and upper-cases old names", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-super-home-" });
      const dir = path.join(baseDir, "super-t3");
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.writeFileString(path.join(dir, "router.md"), "# My router\n");

      const home = yield* SuperT3Home.SuperT3Home.pipe(
        Effect.provide(
          SuperT3Home.layer.pipe(Layer.provide(ServerConfig.layerTest(baseDir, baseDir))),
        ),
      );
      const names = yield* fs.readDirectory(dir);
      assert.includeMembers(names, ["ROUTER.md", "WORKER.md", "config.json", "router"]);
      assert.notInclude(names, "router.md");
      assert.strictEqual(yield* home.routerInstructions, "# My router\n");
      assert.strictEqual(yield* home.workerInstructions, DEFAULT_WORKER_MD);
      assert.deepStrictEqual(yield* home.config, SuperT3Home.DEFAULT_CONFIG);

      // An edit applies on the next read; an empty WORKER.md adds nothing.
      yield* fs.writeFileString(path.join(dir, "WORKER.md"), "  \n");
      assert.isUndefined(yield* home.workerInstructions);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
