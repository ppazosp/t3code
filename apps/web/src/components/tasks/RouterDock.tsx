import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2Icon, RouteIcon } from "lucide-react";
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

/** The row that names the router, on the composer's top edge. */
const LABEL_HEIGHT = 30;

/** The board fades out over this much space above the router's caption. */
const FADE_HEIGHT = 24;

/** How long after the user presses send their message may take to reach the router. */
const SEND_WINDOW_MS = 30_000;

/**
 * The router's own composer, floating over the bottom of the board: T3's composer with its model,
 * mode and attachment controls. Only the composer shows. Once a message sent from here reaches the router,
 * its conversation opens like any other thread's. It runs as an embedded chat, so the board keeps
 * the keyboard and the page layout.
 */
export function RouterDock({
  router,
  now,
  composerRef,
  onHeightChange,
}: {
  router: EnvironmentThreadShell;
  now: string;
  composerRef: ComposerHandleRef;
  /** The room the floating dock covers at the bottom of the board, in pixels. */
  onHeightChange: (height: number) => void;
}) {
  const navigate = useNavigate();
  const sentRef = useRef<{ at: number; since: string | null } | null>(null);
  const [composer, setComposer] = useState<{
    height: number;
    left: number;
    width: number;
  } | null>(null);
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
    composerPlaceholder: "Message the router…",
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the composer ChatView renders late, so the dock fits it and its label sits on its edge
  useEffect(() => {
    const container = chatRef.current;
    if (container === null) return;
    let release: (() => void) | null = null;
    const attach = () => {
      const overlay = container.querySelector('[data-chat-composer-overlay="true"]');
      const stack = container.querySelector('[data-chat-composer-stack="true"]');
      if (overlay === null || stack === null || release !== null) return;
      release = observeResize(overlay, () => {
        const box = stack.getBoundingClientRect();
        const origin = container.getBoundingClientRect();
        setComposer({
          height: overlay.getBoundingClientRect().height,
          left: box.left - origin.left,
          width: box.width,
        });
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
  const height = composer === null ? null : composer.height + LABEL_HEIGHT + FADE_HEIGHT;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the board how much room to leave under its cards
  useEffect(() => onHeightChange(height ?? 0), [height, onHeightChange]);

  return (
    // The composer floats over the board, which fades out behind it; only the composer and its
    // open button take clicks.
    <section
      aria-label="Router"
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col"
      style={{ height: height === null ? "10rem" : `${height}px` }}
    >
      <div
        aria-hidden
        className="shrink-0 bg-linear-to-t from-background to-transparent"
        style={{ height: FADE_HEIGHT }}
      />
      <div aria-hidden className="flex-1 bg-background" />
      {composer === null ? null : (
        <div
          className="absolute flex items-center gap-1.5 px-4 text-xs text-muted-foreground"
          style={{
            top: FADE_HEIGHT,
            left: composer.left,
            width: composer.width,
            height: LABEL_HEIGHT,
          }}
        >
          <RouteIcon aria-hidden className="size-3.5" />
          <span>Router</span>
          <TaskStatusPill task={task} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  className="pointer-events-auto ml-auto"
                  aria-label="Open the router's conversation"
                  onClick={openRouter}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="top">Open conversation</TooltipPopup>
          </Tooltip>
        </div>
      )}
      <div
        ref={chatRef}
        data-side-chat-pane
        // Only the composer shows, over the board; the conversation opens in its own page.
        className="absolute inset-x-0 bottom-0 flex flex-col overflow-hidden *:bg-transparent [&_[data-chat-workspace-drop-target]>:not([data-chat-composer-overlay])]:invisible"
        style={{ height: composer === null ? "9rem" : `${composer.height}px` }}
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
