import { assert, describe, it } from "@effect/vitest";

import { progressContent } from "./progress.ts";

const step = (id: string, status: "pending" | "running" | "completed") => ({
  id,
  text: `Step ${id}`,
  status,
});

describe("progressContent", () => {
  it("shows one card per step, spinning until each is done", () => {
    const { blocks } = progressContent({
      title: "Fix <!channel>",
      steps: [step("1", "completed"), step("2", "running"), step("3", "pending")],
      finished: null,
    });
    assert.deepStrictEqual(blocks[0], {
      type: "section",
      text: { type: "mrkdwn", text: "*Fix &lt;!channel&gt;*" },
    });
    assert.deepStrictEqual(
      blocks.slice(1).map((block) => block.status),
      ["complete", "in_progress", "in_progress"],
    );
    const named = progressContent({
      title: "Fix",
      steps: [{ id: "1", text: `Ping <!here> ${"x".repeat(300)}`, status: "running" }],
      finished: null,
    });
    const title = String(named.blocks[1]!.title);
    assert.isTrue(title.startsWith("Ping &lt;!here&gt;"));
    assert.isAtMost(title.length, 220);
  });

  it("marks unfinished steps as failed when the run fails, and adds the result as plain text", () => {
    const { blocks } = progressContent({
      title: "Fix",
      steps: [step("1", "completed"), step("2", "running")],
      finished: { outcome: "failed", result: "Tests broke <@U1>" },
    });
    assert.deepStrictEqual(
      blocks.filter((block) => block.type === "task_card").map((block) => block.status),
      ["complete", "error"],
    );
    assert.strictEqual(blocks.at(-1)!.type, "markdown");
    assert.strictEqual(blocks.length, 5);

    const linked = progressContent({
      title: "Fix",
      steps: [],
      finished: {
        outcome: "completed",
        result: "Changed [calc.py](/Users/me/repo/calc.py), see [docs](https://example.com/a).",
      },
    });
    assert.strictEqual(
      linked.blocks.at(-1)!.text,
      "Changed calc.py, see docs (https://example.com/a).",
    );
  });

  it("folds the earliest steps so a long plan fits in one message", () => {
    const steps = Array.from({ length: 60 }, (_, index) => step(String(index), "completed"));
    const { blocks } = progressContent({ title: "Big", steps, finished: null });
    assert.isAtMost(blocks.length, 50);
    assert.strictEqual(blocks[1]!.title, "14 earlier steps");
  });
});
