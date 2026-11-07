import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient } from "effect/http";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { reportTarget } from "./bridge.ts";
import { ChannelError, type ChannelAdapter, type ChannelHistoryEntry } from "./Channel.ts";
import * as ChannelBridge from "./ChannelBridge.ts";
import { openChannelFile } from "./files.ts";
import { CHANNELS } from "./registry.ts";

export { ChannelError } from "./Channel.ts";

/** The most a task may say in its conversation at once. */
const SAY_LIMIT = 3000;
/** The most files a task may attach to one post. */
const FILES_LIMIT = 10;

export interface ChannelsShape {
  /** Posts the router's reply where a channel message came from, named by the `ref` it carried. */
  readonly reply: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
  /**
   * Marks the user's message handled once the router proposed work for it. Nothing is posted: the
   * proposal waits in T3, and the router stays quiet there.
   */
  readonly proposed: (ref: string) => Effect.Effect<void, ChannelError>;
  /**
   * Posts a task's short answer in the conversation the user asked for it in, and nowhere else,
   * with any images or videos from its working folder.
   */
  readonly say: (
    threadId: ThreadId,
    text: string,
    files: ReadonlyArray<string>,
  ) => Effect.Effect<void, ChannelError>;
  /** The latest messages of a conversation, for the router to read what came before. */
  readonly read: (
    ref: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ChannelHistoryEntry>, ChannelError>;
  /** The latest messages of the conversation a task came from, and of no other. */
  readonly readTask: (
    threadId: ThreadId,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<ChannelHistoryEntry>, ChannelError>;
}

/**
 * The channels outside T3, each an adapter behind one interface (see `registry.ts`). The bridge
 * passes their messages to the router or to the task they answer, and reports approved tasks back
 * where they came from.
 */
export class Channels extends Context.Service<Channels, ChannelsShape>()("t3/channels/Channels") {}

export const layer: Layer.Layer<
  Channels,
  never,
  | ThreadManagementService.ThreadManagementService
  | Orchestrator.OrchestratorV2
  | ProjectStore.ProjectStoreV2
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
> = Layer.effect(
  Channels,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const fileServices = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const state = ChannelBridge.makeState();
    const adapters: Array<ChannelAdapter> = [];
    for (const channel of CHANNELS) {
      const adapter = yield* channel.connect;
      if (Option.isSome(adapter)) adapters.push(adapter.value);
    }
    const prefixes = adapters.map((adapter) => adapter.prefix);
    if (adapters.length > 0) {
      yield* Effect.forkScoped(
        ChannelBridge.run({ adapters, threads, engine, state }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("The channel bridge stopped", { cause })),
        ),
      );
    }
    const adapterFor = (ref: string) =>
      Effect.fromNullishOr(adapters.find((candidate) => ref.startsWith(candidate.prefix))).pipe(
        Effect.mapError(() => new ChannelError({ message: "No channel is connected to this T3." })),
      );
    /** Posts in a conversation, and marks the user's messages there as handled. */
    const postHandled = Effect.fn("Channels.postHandled")(function* (ref: string, text: string) {
      const adapter = yield* adapterFor(ref);
      yield* adapter.post(ref, { text });
      yield* ChannelBridge.markHandled(state, adapter, ref);
    });
    /** The conversation a task came from, where it posts. */
    const taskConversation = Effect.fn("Channels.taskConversation")(function* (threadId: ThreadId) {
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => new ChannelError({ message: "Could not read this thread." })));
      const ref =
        shell === null ? null : reportTarget(ChannelBridge.toBridgeThread(shell), prefixes);
      if (shell === null || ref === null) {
        return yield* new ChannelError({
          message: "This thread did not come from a conversation in a channel.",
        });
      }
      return { ref, shell };
    });
    /** The folder a task works in, where the files it attaches must be. */
    const workingFolder = Effect.fn("Channels.workingFolder")(function* (shell: {
      readonly worktreePath: string | null;
      readonly projectId: ProjectId;
    }) {
      if (shell.worktreePath !== null) return shell.worktreePath;
      const project = yield* projects.get(shell.projectId).pipe(Effect.orElseSucceed(Option.none));
      if (Option.isNone(project)) {
        return yield* new ChannelError({ message: "Could not find your working folder." });
      }
      return project.value.workspaceRoot;
    });
    return Channels.of({
      proposed: Effect.fn("Channels.proposed")(function* (ref) {
        const adapter = yield* adapterFor(ref);
        yield* ChannelBridge.markHandled(state, adapter, ref);
        state.proposed.add(ref);
        if (state.proposed.size > 500) state.proposed.delete(state.proposed.values().next().value!);
      }),
      reply: Effect.fn("Channels.reply")(function* (ref, text) {
        if (state.proposed.has(ref)) {
          return yield* new ChannelError({
            message:
              "You proposed work for this message, and the proposal is the answer: the user sees it in T3. End your turn without a reply.",
          });
        }
        // The router answers only where the user wrote to it, so text it read from anyone else
        // cannot send it to post somewhere new.
        if (!state.userRefs.has(ref)) {
          return yield* new ChannelError({
            message: `You can reply only to a message the user sent you; ${ref} is not one.`,
          });
        }
        yield* postHandled(ref, text);
      }),
      say: Effect.fn("Channels.say")(function* (threadId, text, paths) {
        const { ref, shell } = yield* taskConversation(threadId);
        if (text.length > SAY_LIMIT) {
          return yield* new ChannelError({
            message: `Keep it under ${SAY_LIMIT} characters; the rest belongs in your result.`,
          });
        }
        if (paths.length > FILES_LIMIT) {
          return yield* new ChannelError({
            message: `Attach at most ${FILES_LIMIT} files at once.`,
          });
        }
        const adapter = yield* adapterFor(ref);
        if (paths.length > 0 && adapter.fileLimit === 0) {
          return yield* new ChannelError({ message: `${adapter.name} takes no files.` });
        }
        const root = paths.length === 0 ? "" : yield* workingFolder(shell);
        yield* Effect.forEach(paths, (path) =>
          openChannelFile(root, path, adapter.fileLimit).pipe(Effect.provide(fileServices)),
        ).pipe(
          Effect.flatMap((files) => adapter.post(ref, { text, files })),
          Effect.scoped,
        );
      }),
      read: Effect.fn("Channels.read")(function* (ref, limit) {
        const adapter = yield* adapterFor(ref);
        return yield* adapter.read(ref, Math.max(1, Math.min(limit, 100)));
      }),
      readTask: Effect.fn("Channels.readTask")(function* (threadId, limit) {
        const { ref } = yield* taskConversation(threadId);
        const adapter = yield* adapterFor(ref);
        return yield* adapter.read(ref, Math.max(1, Math.min(limit, 100)));
      }),
    });
  }),
);
