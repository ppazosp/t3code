import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { RouteIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskStatusPill } from "./TaskPresentation";
import { resolveTaskStatus } from "./tasks.logic";

/** How long after the user presses send their message may take to reach the router. */
const SEND_WINDOW_MS = 30_000;

/**
 * The router's own composer, docked under the board: T3's composer with its model, mode and
 * attachment controls. Only the composer shows. Once a message sent from here reaches the router,
 * its conversation opens like any other thread's. It runs as an embedded chat, so the board keeps
 * the keyboard and the page layout.
 */
export function RouterDock({
  router,
  now,
  composerRef,
}: {
  router: EnvironmentThreadShell;
  now: string;
  composerRef: ComposerHandleRef;
}) {
  const navigate = useNavigate();
  const sentRef = useRef<{ at: number; since: string | null } | null>(null);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const routerRef = scopeThreadRef(router.environmentId, router.id);
  const task = {
    key: router.id,
    thread: router,
    status: resolveTaskStatus(router, now),
    subtasks: [],
  };

  const openRouter = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(routerRef) });
  // The router cannot run commands; its diffs and links open in its full conversation.
  const parentPanel: SideChatParentPanel = {
    openToolDiff: openRouter,
    runShellCommand: () => {},
  };

  // The composer sends inside ChatView, so the dock notes the attempt and waits for the router to
  // record the message: opening the conversation earlier could cut the send short.
  const noteSend = () => {
    sentRef.current = { at: Date.now(), since: router.latestUserMessageAt };
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the router's conversation once the message sent from the dock reaches it
  useEffect(() => {
    const sent = sentRef.current;
    if (sent === null || router.latestUserMessageAt === sent.since) return;
    sentRef.current = null;
    if (Date.now() - sent.at < SEND_WINDOW_MS) openRouter();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the composer ChatView renders late, so the collapsed dock fits it exactly
  useEffect(() => {
    const container = chatRef.current;
    if (container === null) return;
    let release: (() => void) | null = null;
    const attach = () => {
      const overlay = container.querySelector('[data-chat-composer-overlay="true"]');
      if (overlay === null || release !== null) return;
      release = observeResize(overlay, () => {
        setComposerHeight(overlay.getBoundingClientRect().height);
      });
    };
    attach();
    const mutations = new MutationObserver(attach);
    mutations.observe(container, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      release?.();
    };
  }, []);

  return (
    <section
      aria-label="Router"
      className="flex shrink-0 flex-col border-t border-border/70 bg-background"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 pr-2 pl-4 text-xs sm:pl-6">
        <RouteIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Router</span>
        <TaskStatusPill task={task} />
        <span className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label="Open the router's conversation"
                  onClick={openRouter}
                />
              }
            >
              <SquareArrowOutUpRightIcon />
            </TooltipTrigger>
            <TooltipPopup side="top">Open conversation</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      <div
        ref={chatRef}
        data-side-chat-pane
        // Only the composer shows; the conversation opens in its own page.
        className="relative flex min-h-0 flex-col overflow-hidden [&_[data-chat-workspace-drop-target]>:not([data-chat-composer-overlay])]:invisible"
        style={{ height: composerHeight === null ? "9rem" : `${composerHeight}px` }}
        onSubmitCapture={noteSend}
        onKeyDownCapture={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)
            noteSend();
        }}
      >
        <BackgroundThreadContext value>
          <ComposerHandleContext value={composerRef}>
            <ChatView
              environmentId={router.environmentId}
              threadId={router.id}
              routeKind="server"
              embedded={parentPanel}
            />
          </ComposerHandleContext>
        </BackgroundThreadContext>
      </div>
    </section>
  );
}
