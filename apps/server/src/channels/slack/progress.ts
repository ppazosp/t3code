import type { Progress, ProgressStep } from "../Channel.ts";
import { escapeSlackText, slackMarkdown } from "./parse.ts";

/** A message holds at most 50 blocks: the title, the outcome, the result and 47 step cards. */
const MAX_CARDS = 47;

/** Long results are cut, well inside Slack's limits, and point to the task for the rest. */
const MAX_RESULT = 3000;

/** Step titles are short in a card; a longer one is cut. */
const MAX_STEP_TITLE = 200;

/** A step's text comes from the model, so it cannot ping anyone or hide a link, and stays short. */
const stepTitle = (text: string) =>
  escapeSlackText(text.length <= MAX_STEP_TITLE ? text : `${text.slice(0, MAX_STEP_TITLE)}…`);

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

const FINISHED_TITLE = { completed: "Done", failed: "Failed", interrupted: "Stopped" } as const;

function cardsOf(progress: Progress): ReadonlyArray<Card> {
  if (progress.steps.length === 0) {
    const status: CardStatus =
      progress.finished === null
        ? "in_progress"
        : progress.finished.outcome === "completed"
          ? "complete"
          : "error";
    const title =
      progress.finished === null ? "Working" : FINISHED_TITLE[progress.finished.outcome];
    return [{ id: "working", title, status }];
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
 * Markdown links as rich text shows them: a local file is just its name, which means nothing as a
 * path on someone else's screen; a web link keeps its address.
 */
const plainLinks = (text: string) =>
  text.replaceAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, (_, label: string, target: string) =>
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(target) && !target.startsWith("file:")
      ? `${label} (${target})`
      : label,
  );

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
      title: stepTitle(card.title),
      status: card.status,
    })),
  ];
  const outcome = progress.finished === null ? null : OUTCOME_LINE[progress.finished.outcome];
  if (outcome !== null) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: outcome }] });
  }
  const full = plainLinks(progress.finished?.result?.trim() ?? "");
  const result =
    full.length <= MAX_RESULT ? full : `${full.slice(0, MAX_RESULT)}…\n\nThe rest is in T3.`;
  // Markdown, as the worker wrote it, made safe like a plan: no pings, and no hidden links.
  if (result !== "") blocks.push({ type: "markdown", text: slackMarkdown(result) });
  const fallback = [progress.title, outcome, result].filter(Boolean).join("\n\n");
  return { text: escapeSlackText(fallback), blocks };
}
