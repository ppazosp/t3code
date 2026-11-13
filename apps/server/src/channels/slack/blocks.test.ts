import { assert, describe, it } from "@effect/vitest";

import { slackBlocks } from "./blocks.ts";

const fence = (body: string) => "```chart\n" + body + "\n```";
const pie = (title: string) =>
  fence(JSON.stringify({ kind: "pie", title, segments: [{ label: "Late", value: 3 }] }));

describe("slackBlocks", () => {
  it("draws valid chart fences between Markdown, and leaves the rest as code", () => {
    const bar = fence(
      JSON.stringify({
        kind: "bar",
        title: "Load",
        categories: ["Mon", "Tue"],
        series: [{ name: "Requests", values: [4, 7] }],
        yLabel: "req/s",
      }),
    );
    const { blocks, fallback } = slackBlocks(
      `**Orders** <!here>\n${pie("Orders")}\nthen\n${bar}\n${fence("{oops")}\n${pie("Third")}`,
    );
    assert.deepStrictEqual(
      blocks.map((block) => block.type),
      ["markdown", "data_visualization", "markdown", "data_visualization", "markdown"],
    );
    assert.strictEqual(blocks[0]!.text, "**Orders** &lt;!here&gt;\n");
    assert.deepStrictEqual(blocks[3], {
      type: "data_visualization",
      title: "Load",
      chart: {
        type: "bar",
        series: [
          {
            name: "Requests",
            data: [
              { label: "Mon", value: 4 },
              { label: "Tue", value: 7 },
            ],
          },
        ],
        axis_config: { categories: ["Mon", "Tue"], y_label: "req/s" },
      },
    });
    // A broken chart, and a third one, stay code in the Markdown after.
    assert.include(String(blocks[4]!.text), "{oops");
    assert.include(String(blocks[4]!.text), "Third");
    assert.include(fallback, "[chart: Orders]");
    assert.notInclude(fallback, "Requests");
  });

  it("is one Markdown block without charts, and nothing for blank text", () => {
    assert.deepStrictEqual(slackBlocks("hi").blocks, [{ type: "markdown", text: "hi" }]);
    assert.deepStrictEqual(slackBlocks("  ").blocks, []);
  });
});
