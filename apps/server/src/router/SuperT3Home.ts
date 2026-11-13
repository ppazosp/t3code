import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { DEFAULT_ROUTER_MD, DEFAULT_WORKER_MD } from "./defaults.ts";

const ModelChoice = Schema.Struct({
  /** A provider instance in T3, such as `codex` or `claudeAgent`. */
  instanceId: Schema.String,
  model: Schema.String,
  /** A reasoning level the model's own control names, such as `high`. */
  effort: Schema.optional(Schema.String),
});
export type ModelChoice = typeof ModelChoice.Type;

const SuperT3Config = Schema.Struct({
  router: Schema.Struct({ model: ModelChoice }),
  workers: Schema.Struct({ codex: ModelChoice, claude: ModelChoice }),
});
export type SuperT3Config = typeof SuperT3Config.Type;

export const DEFAULT_CONFIG: SuperT3Config = {
  router: { model: { instanceId: "codex", model: "gpt-6.1-sol", effort: "medium" } },
  workers: {
    codex: { instanceId: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    claude: { instanceId: "claudeAgent", model: "claude-opus-5-5", effort: "high" },
  },
};

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(SuperT3Config));
const DEFAULT_CONFIG_TEXT = `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;

/**
 * super-t3's own folder in T3's home: `config.json` (the router's and workers' models), `ROUTER.md`
 * (the router's system prompt) and `WORKER.md` (added to every worker's). They start as defaults and
 * the user edits them; each read takes the file as it is now, so an edit applies on the next turn.
 */
export class SuperT3Home extends Context.Service<
  SuperT3Home,
  {
    readonly dir: string;
    /** An empty folder the router works in, so no project's AGENTS.md or files reach it. */
    readonly routerDir: string;
    readonly config: Effect.Effect<SuperT3Config>;
    readonly routerInstructions: Effect.Effect<string>;
    /** Nothing when WORKER.md is empty. */
    readonly workerInstructions: Effect.Effect<string | undefined>;
  }
>()("t3/router/SuperT3Home") {}

export const layer = Layer.effect(
  SuperT3Home,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* ServerConfig;
    const dir = path.join(baseDir, "super-t3");
    const routerDir = path.join(dir, "router");
    const files = {
      config: path.join(dir, "config.json"),
      router: path.join(dir, "ROUTER.md"),
      worker: path.join(dir, "WORKER.md"),
    };
    // Homes made before the names were upper case: rename by exact listing, since macOS matches
    // names without case and would report ROUTER.md as there already.
    const renameLowerCase = Effect.gen(function* () {
      const names = yield* fs.readDirectory(dir);
      for (const [lower, upper] of [
        ["router.md", "ROUTER.md"],
        ["worker.md", "WORKER.md"],
      ] as const) {
        if (names.includes(lower) && !names.includes(upper)) {
          yield* fs.rename(path.join(dir, lower), path.join(dir, upper));
        }
      }
    }).pipe(Effect.ignore);
    // Seed what is missing; never overwrite what the user wrote.
    const seed = (file: string, text: string) =>
      fs
        .exists(file)
        .pipe(Effect.flatMap((exists) => (exists ? Effect.void : fs.writeFileString(file, text))));
    yield* fs.makeDirectory(routerDir, { recursive: true }).pipe(Effect.ignore);
    yield* renameLowerCase;
    yield* Effect.all([
      seed(files.config, DEFAULT_CONFIG_TEXT),
      seed(files.router, DEFAULT_ROUTER_MD),
      seed(files.worker, DEFAULT_WORKER_MD),
    ]).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not set up super-t3's folder", { cause }),
      ),
    );
    const read = (file: string) =>
      fs.readFileString(file).pipe(Effect.orElseSucceed(() => undefined));
    return SuperT3Home.of({
      dir,
      routerDir,
      config: read(files.config).pipe(
        Effect.flatMap((text) =>
          text === undefined
            ? Effect.succeed(DEFAULT_CONFIG)
            : decodeConfig(text).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("super-t3/config.json is not valid; using the defaults", {
                    cause,
                  }).pipe(Effect.as(DEFAULT_CONFIG)),
                ),
              ),
        ),
      ),
      routerInstructions: read(files.router).pipe(
        Effect.map((text) => (text === undefined || text.trim() === "" ? DEFAULT_ROUTER_MD : text)),
      ),
      workerInstructions: read(files.worker).pipe(
        Effect.map((text) => (text === undefined || text.trim() === "" ? undefined : text)),
      ),
    });
  }),
);

/** A home with fixed files, for tests. */
export const layerOf = (files: {
  readonly routerInstructions?: string;
  readonly workerInstructions?: string;
  readonly config?: SuperT3Config;
}) =>
  Layer.succeed(
    SuperT3Home,
    SuperT3Home.of({
      dir: "/super-t3",
      routerDir: "/super-t3/router",
      config: Effect.succeed(files.config ?? DEFAULT_CONFIG),
      routerInstructions: Effect.succeed(files.routerInstructions ?? DEFAULT_ROUTER_MD),
      workerInstructions: Effect.succeed(files.workerInstructions),
    }),
  );
