import { assert, describe, it } from "@effect/vitest";

import { chartProblem } from "./Channels.ts";

const bar = {
  kind: "bar" as const,
  title: "Load",
  categories: ["Mon", "Tue"],
  series: [{ name: "Requests", values: [4, 7] }],
};

describe("chartProblem", () => {
  it("accepts a chart Slack can draw, and names the first limit one breaks", () => {
    assert.isNull(chartProblem(bar));
    assert.isNull(
      chartProblem({ kind: "pie", title: "Orders", segments: [{ label: "A", value: 1 }] }),
    );
    assert.match(chartProblem({ ...bar, title: "x".repeat(51) })!, /title/u);
    assert.match(
      chartProblem({ ...bar, series: [{ name: "Requests", values: [4] }] })!,
      /one value per category/u,
    );
    assert.match(chartProblem({ ...bar, categories: ["Mon", "Mon"] })!, /different/u);
    assert.match(
      chartProblem({ kind: "pie", title: "Orders", segments: [{ label: "A", value: 0 }] })!,
      /above 0/u,
    );
  });
});
