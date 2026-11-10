import {
  channelSourceLabels,
  ThreadId,
  type ChannelHeader,
  type EnvironmentId,
  type WorkerRequest,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { useThreadShell } from "~/state/entities";

import { RelativeTime } from "../RelativeTime";
import { SourceIcon } from "./SourceIcon";

/**
 * A message from a channel, as the router received it: where it came from, the way a proposal's
 * tab shows it, and the message itself. The header the router reads stays out of sight.
 */
export function ChannelMessageRow({ header, at }: { header: ChannelHeader; at: string }) {
  return (
    <div className="flex justify-end" data-user-message-attribution="channel">
      <div className="w-fit max-w-[80%] min-w-72 rounded-2xl border border-border bg-card px-4 pt-3 pb-3.5">
        <ChannelSourceLine header={header} at={at} />
        <blockquote
          className="mt-2 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-foreground"
          data-thread-find-text="true"
        >
          {header.body}
        </blockquote>
      </div>
    </div>
  );
}

/** The channel's logo, where and who a message came from, and when, if known. */
export function ChannelSourceLine({ header, at }: { header: ChannelHeader; at?: string }) {
  const { where, author } = channelSourceLabels(header);
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <SourceIcon kind={header.channel} className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {where} · {author}
        {at === undefined ? null : (
          <>
            {" · "}
            <RelativeTime timestamp={at} />
          </>
        )}
      </span>
    </div>
  );
}

/** A worker's request to the router, shown like a channel message: who asked, and their words. */
export function WorkerRequestRow({
  environmentId,
  request,
  at,
}: {
  environmentId: EnvironmentId;
  request: WorkerRequest;
  at: string;
}) {
  return (
    <div className="flex justify-end" data-user-message-attribution="worker">
      <div className="w-fit max-w-[80%] min-w-72 rounded-2xl border border-border bg-card px-4 pt-3 pb-3.5">
        <WorkerSourceLine environmentId={environmentId} threadId={request.threadId} at={at} />
        <blockquote
          className="mt-2 border-l-2 border-border pl-3 text-sm whitespace-pre-wrap text-foreground"
          data-thread-find-text="true"
        >
          {request.body}
        </blockquote>
      </div>
    </div>
  );
}

/** The worker that asked, linked to its thread, and when, if known. */
export function WorkerSourceLine({
  environmentId,
  threadId,
  at,
}: {
  environmentId: EnvironmentId;
  threadId: string;
  at?: string;
}) {
  const id = ThreadId.make(threadId);
  const shell = useThreadShell({ environmentId, threadId: id });
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <SourceIcon kind="worker" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: id }}
          className="hover:text-foreground hover:underline"
        >
          {shell?.title.trim() || "A worker"}
        </Link>
        {" · Worker"}
        {at === undefined ? null : (
          <>
            {" · "}
            <RelativeTime timestamp={at} />
          </>
        )}
      </span>
    </div>
  );
}
