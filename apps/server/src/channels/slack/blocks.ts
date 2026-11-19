import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { slackMarkdown } from "./parse.ts";

const Title = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50));
const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(20));

/** The charts Slack's data visualization block draws, within its limits. */
const Chart = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pie"),
    title: Title,
    segments: Schema.Array(
      Schema.Struct({ label: Label, value: Schema.Number.check(Schema.isGreaterThan(0)) }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  }),
  Schema.Struct({
    kind: Schema.Literals(["bar", "line", "area"]),
    title: Title,
    categories: Schema.Array(Label).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    series: Schema.Array(Schema.Struct({ name: Label, values: Schema.Array(Schema.Number) })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(12),
    ),
    xLabel: Schema.optional(Label),
    yLabel: Schema.optional(Label),
  }),
]);
type Chart = typeof Chart.Type;
const decodeChart = Schema.decodeUnknownOption(Schema.fromJsonString(Chart));

/** Slack draws at most two charts in one message. */
const CHART_LIMIT = 2;

const CHART_FENCE = /```chart[ \t]*\r?\n([\s\S]*?)\r?\n```/gu;

const chartBlock = (chart: Chart) =>
  chart.kind === "pie"
    ? {
        type: "data_visualization",
        title: chart.title,
        chart: { type: "pie", segments: chart.segments },
      }
    : {
        type: "data_visualization",
        title: chart.title,
        chart: {
          type: chart.kind,
          series: chart.series.map((series) => ({
            name: series.name,
            data: chart.categories.map((label, index) => ({
              label,
              value: series.values[index] ?? 0,
            })),
          })),
          axis_config: {
            categories: chart.categories,
            ...(chart.xLabel === undefined ? {} : { x_label: chart.xLabel }),
            ...(chart.yLabel === undefined ? {} : { y_label: chart.yLabel }),
          },
        },
      };

/**
 * A post's Markdown as Slack blocks. A fenced `chart` block holding a valid chart is drawn as one;
 * anything else, a third chart included, stays Markdown and shows as code.
 */
export function slackBlocks(text: string): {
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
  /** What notifications and clients without blocks show. */
  readonly fallback: string;
} {
  const blocks: Array<Record<string, unknown>> = [];
  const fallback: Array<string> = [];
  let markdown = "";
  let charts = 0;
  let last = 0;
  const flush = () => {
    if (markdown.trim() !== "") blocks.push({ type: "markdown", text: slackMarkdown(markdown) });
    markdown = "";
  };
  for (const match of text.matchAll(CHART_FENCE)) {
    const before = text.slice(last, match.index);
    markdown += before;
    fallback.push(before);
    last = match.index + match[0].length;
    const chart = charts < CHART_LIMIT ? decodeChart(match[1]!) : Option.none();
    if (Option.isNone(chart)) {
      markdown += match[0];
      fallback.push(match[0]);
      continue;
    }
    flush();
    blocks.push(chartBlock(chart.value));
    fallback.push(`[chart: ${chart.value.title}]`);
    charts += 1;
  }
  markdown += text.slice(last);
  fallback.push(text.slice(last));
  flush();
  return { blocks, fallback: fallback.join("") };
}
