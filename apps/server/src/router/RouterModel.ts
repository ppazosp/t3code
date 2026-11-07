import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { workerModelSelection } from "./Proposals.ts";
import { isRouterThread } from "./RouterRuntimePolicy.ts";
import { SuperT3Home } from "./SuperT3Home.ts";

const sameSelection = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  (left.options ?? []).length === (right.options ?? []).length &&
  (left.options ?? []).every((option) =>
    (right.options ?? []).some((other) => other.id === option.id && other.value === option.value),
  );

/**
 * Keeps the router on the model super-t3's config.json names: at start, when a router appears, and
 * whenever the file changes. The model can still be changed in the router's thread until then.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const home = yield* SuperT3Home;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const providerRegistry = yield* ProviderRegistry;
    const fs = yield* FileSystem.FileSystem;

    const apply = Effect.fn("RouterModel.apply")(function* (thread: {
      readonly id: string;
      readonly modelSelection: ModelSelection;
    }) {
      const choice = (yield* home.config).router.model;
      const modelSelection = workerModelSelection(choice, yield* providerRegistry.getProviders);
      if (sameSelection(thread.modelSelection, modelSelection)) return;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      yield* threads.dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`router-model:${thread.id}:${now}`),
        threadId: ThreadId.make(thread.id),
        modelSelection,
      });
    });
    const applyAll = threads.listProjectThreads({ includeSubagents: false }).pipe(
      Effect.flatMap((shells) =>
        Effect.forEach(
          shells.filter((shell) => isRouterThread(shell) && shell.archivedAt === null),
          apply,
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not set the router's model", { cause }),
      ),
    );

    yield* applyAll;
    const onEvent = (event: OrchestrationV2DomainEvent) =>
      event.type === "thread.tags-updated" && isRouterThread(event.payload)
        ? applyAll
        : Effect.void;
    yield* Effect.forkScoped(Stream.runForEach(engine.streamDomainEvents, onEvent));
    yield* Effect.forkScoped(
      fs.watch(home.dir).pipe(
        Stream.runForEach(() => applyAll),
        Effect.catchCause((cause) =>
          Effect.logWarning("Stopped watching super-t3's config", { cause }),
        ),
      ),
    );
  }),
);
