import type { Progress, ProgressStep } from "../Channel.ts";
import { escapeSlackText } from "./parse.ts";

/** A message holds at most 50 blocks: the title, the outcome, the result and 47 step cards. */
const MAX_CARDS = 47;

/** Long results are cut, well inside Slack's limits, and point to the task for the rest. */
const MAX_RESULT = 3000;

type CardStatus = "in_progress" | "complete" | "error";

interface Card {
  readonly id: string;
  readonly title: string;
  readonly status: CardStatus;
}

function cardStatus(step: ProgressStep, finished: Progress["finished"]): CardStatus {
  if (step.status === "completed") return "complete";
  // Once the run ends, a step it never finished did not happen.
  if (finished !== null) return finished.outcome === "completed" ? "complete" : "error";
  // Slack has no card for a step not yet started; it spins with the running one.
  return "in_progress";
}

function cardsOf(progress: Progress): ReadonlyArray<Card> {
  if (progress.steps.length === 0) {
    const status: CardStatus =
      progress.finished === null
        ? "in_progress"
        : progress.finished.outcome === "completed"
          ? "complete"
          : "error";
    return [{ id: "working", title: "Working", status }];
  }
  const cards = progress.steps.map((step) => ({
    id: step.id,
    title: step.text,
    status: cardStatus(step, progress.finished),
  }));
  if (cards.length <= MAX_CARDS) return cards;
  // Too many to show: the earliest finished steps fold into one card.
  const folded = cards.length - MAX_CARDS + 1;
  const done = cards.slice(0, folded);
  return [
    {
      id: "earlier",
      title: `${folded} earlier steps`,
      status: done.some((card) => card.status === "error") ? "error" : "complete",
    },
    ...cards.slice(folded),
  ];
}

const OUTCOME_LINE = {
  completed: null,
  failed: "The task failed. Open it in T3 to see why.",
  interrupted: "The task was stopped.",
} as const;

/**
 * Slack's timeline style: the task's title, one card per step of its plan with its own spinner,
 * check or warning, then the outcome and the task's last message once it ends.
 */
export function progressContent(progress: Progress): {
  readonly text: string;
  readonly blocks: ReadonlyArray<Record<string, unknown>>;
} {
  const blocks: Array<Record<string, unknown>> = [
    { type: "section", text: { type: "mrkdwn", text: `*${escapeSlackText(progress.title)}*` } },
    ...cardsOf(progress).map((card) => ({
      type: "task_card",
      task_id: card.id,
      title: card.title,
      status: card.status,
    })),
  ];
  const outcome = progress.finished === null ? null : OUTCOME_LINE[progress.finished.outcome];
  if (outcome !== null) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: outcome }] });
  }
  const full = progress.finished?.result?.trim() ?? "";
  const result =
    full.length <= MAX_RESULT ? full : `${full.slice(0, MAX_RESULT)}…\n\nThe rest is in T3.`;
  // Rich text is never parsed as markup, so a model's message cannot hide a link or ping anyone.
  if (result !== "") {
    blocks.push({
      type: "rich_text",
      elements: [{ type: "rich_text_section", elements: [{ type: "text", text: result }] }],
    });
  }
  const fallback = [progress.title, outcome, result].filter(Boolean).join("\n\n");
  return { text: escapeSlackText(fallback), blocks };
}
