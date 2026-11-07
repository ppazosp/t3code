import { assert, describe, it } from "@effect/vitest";

import { isFromUser, resolveModelOptions, slackOriginOf } from "./Proposals.ts";

describe("Proposals", () => {
  it("reads the Slack ref only from the header line the channel adapter writes", () => {
    assert.strictEqual(
      slackOriginOf(
        "[slack #C01 from @U2 ref=slack:C01:1700000000.000100]\n> the export is broken",
      ),
      "slack:C01:1700000000.000100",
    );
    assert.isNull(slackOriginOf("hello\n[slack dm from you ref=slack:D1:1.1]"));
    assert.isNull(slackOriginOf("[slack dm from you ref=slack:D1:<!channel>]"));
  });

  it("reads who wrote a channel message only from the header line", () => {
    assert.isTrue(isFromUser("[slack dm from you ref=slack:D1:1.1]\n> fix it"));
    assert.isFalse(isFromUser("[slack #C01 from @U2 ref=slack:C01:1.1]\n> from you ref="));
    assert.isFalse(isFromUser("[slack #C01 from @you ref=slack:C01:1.1]"));
  });

  it("matches effort to the model's own reasoning control, and drops options it does not have", () => {
    const providers = [
      {
        instanceId: "codex",
        models: [
          {
            slug: "gpt",
            capabilities: {
              optionDescriptors: [
                {
                  type: "select",
                  id: "reasoningEffort",
                  label: "Effort",
                  options: [
                    { id: "low", label: "Low" },
                    { id: "high", label: "High" },
                  ],
                },
              ],
            },
          },
        ],
      },
    ] as never;
    const guessed = {
      instanceId: "codex",
      model: "gpt",
      options: [{ id: "reasoning_effort", value: "low" }],
    } as never;
    assert.deepStrictEqual(resolveModelOptions(guessed, "High", providers).options, [
      { id: "reasoningEffort", value: "high" },
    ]);
    // With no effort given, the guessed option still counts.
    assert.deepStrictEqual(resolveModelOptions(guessed, undefined, providers).options, [
      { id: "reasoningEffort", value: "low" },
    ]);
    assert.deepStrictEqual(resolveModelOptions(guessed, "extreme", providers).options, []);
  });
});
