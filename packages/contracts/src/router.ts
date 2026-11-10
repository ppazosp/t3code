/**
 * The router is one thread the user talks to instead of to every agent. It reads, delegates and
 * follows up; the threads it launches are tasks, and the threads they delegate to are subtasks.
 * The tag is how clients, the server and channel adapters find it.
 */
export const ROUTER_TAG = "router";

/**
 * A proposal is a scheduled task that never fires by itself: paused, and set for this far-off time,
 * which marks it as the router's. Accepting it runs it once; discarding it deletes it.
 */
export const PROPOSAL_RUN_AT = "9999-12-31T00:00:00.000Z";

/**
 * Sent with a proposal's first message, as `accepted:<proposal id>`, so its thread launches tagged.
 * The server then gives the worker the proposal's origin and title, removes the proposal, and drops
 * the tag.
 */
export const ACCEPTED_TAG_PREFIX = "accepted:";

/** Where a proposal came from, as its card shows it: the channel, the author and their message. */
export interface ProposalSource {
  /** The channel's name, such as `slack`. */
  readonly kind: string;
  readonly where: string;
  readonly author: string;
  readonly text: string;
  readonly at: string;
}

const SOURCE_MARKER = /\n*<!-- super-t3:source (\{.*\}) -->\s*$/su;

/**
 * Appends where a proposal came from to its prompt, in a comment the app reads and strips, so
 * the source travels with the proposal and never reaches the worker. Angle brackets are escaped,
 * so a message cannot close the comment.
 */
export function withProposalSource(brief: string, source: ProposalSource): string {
  const json = JSON.stringify(source).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
  return `${brief}\n\n<!-- super-t3:source ${json} -->`;
}

/** A proposal prompt's brief, and its source when it has one. */
export function readProposalSource(prompt: string): {
  readonly brief: string;
  readonly source: ProposalSource | null;
} {
  const match = SOURCE_MARKER.exec(prompt);
  if (match === null) return { brief: prompt, source: null };
  try {
    const parsed = JSON.parse(match[1]!) as Partial<ProposalSource>;
    const source =
      typeof parsed.kind === "string" &&
      /^[a-z][a-z0-9-]*$/u.test(parsed.kind) &&
      typeof parsed.where === "string" &&
      typeof parsed.author === "string" &&
      typeof parsed.text === "string" &&
      typeof parsed.at === "string"
        ? (parsed as ProposalSource)
        : null;
    return { brief: prompt.slice(0, match.index).trimEnd(), source };
  } catch {
    return { brief: prompt.slice(0, match.index).trimEnd(), source: null };
  }
}

export function isProposalTask(task: {
  readonly enabled: boolean;
  readonly schedule: { readonly type: string; readonly runAt?: string };
}): boolean {
  return !task.enabled && task.schedule.type === "once" && task.schedule.runAt === PROPOSAL_RUN_AT;
}

/**
 * Marks a worker the user asked for in a channel. Only those are reported back in the
 * conversation; work proposed from someone else's message never posts in their thread.
 */
export const FROM_USER_TAG = "from-you";

/** On every thread a proposal became, so it gets WORKER.md for as long as it lives. */
export const WORKER_TAG = "worker";

const CHANNEL_HEADER =
  /^\[([a-z][a-z0-9-]*) (\S+) from (.+?)( to me)? ref=(([a-z][a-z0-9-]*):[^\s\]]+)\]$/u;

/** A channel message as the bridge hands it to the router: a header line, then the message quoted. */
export interface ChannelHeader {
  /** The channel's name, such as `slack`. */
  readonly channel: string;
  readonly where: string;
  readonly author: string;
  readonly ref: string;
  readonly fromUser: boolean;
  /** Written to the bot: a DM or a mention, as opposed to something said where it listens. */
  readonly direct: boolean;
  /** The quoted message under the header. */
  readonly body: string;
}

/**
 * Reads the header of a message the bridge wrote for the router. Only its first line counts, so a
 * header someone typed inside their message, which arrives quoted, never reads as one.
 */
export function readChannelHeader(text: string): ChannelHeader | null {
  const [header = "", ...lines] = text.split("\n");
  const match = CHANNEL_HEADER.exec(header);
  if (match === null || match[1] !== match[6]) return null;
  return {
    channel: match[1]!,
    where: match[2]!,
    author: match[3]!,
    ref: match[5]!,
    fromUser: match[3] === "you",
    direct: match[4] !== undefined,
    body: lines
      .map((line) => line.replace(/^> ?/u, ""))
      .join("\n")
      .trim(),
  };
}

/** Where a channel message came from, as people read it: "DM" or "#eng", and "You" or a name. */
export function channelSourceLabels(header: Pick<ChannelHeader, "where" | "author" | "fromUser">): {
  readonly where: string;
  readonly author: string;
} {
  return {
    where: header.where === "dm" ? "DM" : header.where,
    author: header.fromUser ? "You" : header.author.replace(/^@/u, ""),
  };
}
