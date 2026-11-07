import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { reportTarget } from "./bridge.ts";
import {
  ChannelError,
  type ChannelAdapter,
  type ChannelChart,
  type ChannelHistoryEntry,
} from "./Channel.ts";
import * as ChannelBridge from "./ChannelBridge.ts";
import { CHANNELS } from "./registry.ts";

export { ChannelError } from "./Channel.ts";

/** The most a task may say in its conversation at once. */
const SAY_LIMIT = 3000;

/** Charts a post can carry; Slack draws at most two per message. */
const CHART_LIMIT = 2;

export interface ChannelsShape {
  /** Posts the router's reply where a channel message came from, named by the `ref` it carried. */
  readonly reply: (ref: string, text: string) => Effect.Effect<void, ChannelError>;
  /**
   * Marks the user's message handled once the router proposed work for it. Nothing is posted: the
   * proposal waits in T3, and the router stays quiet there.
   */
  readonly proposed: (ref: string) => Effect.Effect<void, ChannelError>;
  /** Posts a task's short answer in the conversation the user asked for it in, and nowhere else. */
  readonly say: (threadId: ThreadId, text: string) => Effect.Effect<void, ChannelError>;
  /** Attaches a chart to the task's next post, its answer, in the conversation it came from. */
  readonly chart: (threadId: ThreadId, chart: ChannelChart) => Effect.Effect<void, ChannelError>;
  /** The latest messages of a conversation, for the router to read what came before. */
  readonly read: (
    ref: string,
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
  | HttpClient.HttpClient
> = Layer.effect(
  Channels,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const engine = yield* Orchestrator.OrchestratorV2;
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
      if (ref === null) {
        return yield* new ChannelError({
          message: "This thread did not come from a conversation in a channel.",
        });
      }
      return ref;
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
      say: Effect.fn("Channels.say")(function* (threadId, text) {
        const ref = yield* taskConversation(threadId);
        if (text.length > SAY_LIMIT) {
          return yield* new ChannelError({
            message: `Keep it under ${SAY_LIMIT} characters; the rest belongs in your result.`,
          });
        }
        const adapter = yield* adapterFor(ref);
        yield* adapter.post(ref, { text });
      }),
      chart: Effect.fn("Channels.chart")(function* (threadId, chart) {
        yield* taskConversation(threadId);
        const problem = chartProblem(chart);
        if (problem !== null) return yield* new ChannelError({ message: problem });
        const charts = state.charts.get(threadId) ?? [];
        if (charts.length >= CHART_LIMIT) {
          return yield* new ChannelError({
            message: `Your answer already carries ${CHART_LIMIT} charts, the most it can show.`,
          });
        }
        state.charts.set(threadId, [...charts, chart]);
      }),
      read: Effect.fn("Channels.read")(function* (ref, limit) {
        const adapter = yield* adapterFor(ref);
        return yield* adapter.read(ref, Math.max(1, Math.min(limit, 100)));
      }),
    });
  }),
);

/** Why a chart cannot be drawn, by Slack's limits on its data visualization block; null if it can. */
export function chartProblem(chart: ChannelChart): string | null {
  const long = (text: string, max: number) => [...text].length > max;
  if (chart.title.trim() === "" || long(chart.title, 50)) {
    return "A chart's title must be 1 to 50 characters.";
  }
  if (chart.kind === "pie") {
    if (chart.segments.length < 1 || chart.segments.length > 12) {
      return "A pie chart has 1 to 12 segments.";
    }
    if (chart.segments.some((segment) => long(segment.label, 20) || !(segment.value > 0))) {
      return "Each segment needs a label of at most 20 characters and a value above 0.";
    }
    return null;
  }
  if (chart.categories.length < 1 || chart.categories.length > 20) {
    return "A chart has 1 to 20 categories.";
  }
  if (chart.categories.some((category) => long(category, 20))) {
    return "Each category is at most 20 characters.";
  }
  if (new Set(chart.categories).size !== chart.categories.length) {
    return "Categories must be different from each other.";
  }
  if (chart.series.length < 1 || chart.series.length > 12) return "A chart has 1 to 12 series.";
  if (new Set(chart.series.map((series) => series.name)).size !== chart.series.length) {
    return "Series names must be different from each other.";
  }
  for (const series of chart.series) {
    if (long(series.name, 20)) return "Each series name is at most 20 characters.";
    if (series.values.length !== chart.categories.length) {
      return `Series "${series.name}" needs exactly one value per category.`;
    }
  }
  if (
    (chart.xLabel !== undefined && long(chart.xLabel, 50)) ||
    (chart.yLabel !== undefined && long(chart.yLabel, 50))
  ) {
    return "Axis labels are at most 50 characters.";
  }
  return null;
}
