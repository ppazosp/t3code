import { BotIcon, MessageSquareIcon } from "lucide-react";

import { SlackIcon } from "../Icons";

/**
 * The logo of the channel a proposal came from, a bot for a worker's request, and a plain message
 * icon for channels without one.
 */
export function SourceIcon({ kind, className }: { kind: string; className?: string }) {
  if (kind === "worker") return <BotIcon aria-label="Worker" role="img" className={className} />;
  return kind === "slack" ? (
    <SlackIcon aria-label="Slack" role="img" className={className} />
  ) : (
    <MessageSquareIcon aria-label={kind} role="img" className={className} />
  );
}
