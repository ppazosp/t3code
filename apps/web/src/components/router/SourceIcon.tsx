import { MessageSquareIcon } from "lucide-react";

import { SlackIcon } from "../Icons";

/** The logo of the channel a proposal came from; a plain message icon for channels without one. */
export function SourceIcon({ kind, className }: { kind: string; className?: string }) {
  return kind === "slack" ? (
    <SlackIcon aria-label="Slack" role="img" className={className} />
  ) : (
    <MessageSquareIcon aria-label={kind} role="img" className={className} />
  );
}
