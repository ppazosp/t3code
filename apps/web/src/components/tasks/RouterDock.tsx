import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";

/** How long after the user presses send their message may take to reach the router. */
const SEND_WINDOW_MS = 30_000;

/**
 * The router's own composer, floating over the bottom of the board: T3's composer with its model,
 * mode and attachment controls, and nothing else. Once a message sent from here reaches the router,
 * its conversation opens like any other thread's. It runs as an embedded chat, so the board keeps
 * the keyboard and the page layout.
 */
export function RouterDock({
  router,
  composerRef,
  onHeightChange,
}: {
  router: EnvironmentThreadShell;
  composerRef: ComposerHandleRef;
  /** The room the floating composer covers at the bottom of the board, in pixels. */
  onHeightChange: (height: number) => void;
}) {
  const navigate = useNavigate();
  const sentRef = useRef<{ at: number; since: string | null } | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const routerRef = scopeThreadRef(router.environmentId, router.id);

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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the composer ChatView renders late, so the dock fits it exactly
  useEffect(() => {
    const container = chatRef.current;
    if (container === null) return;
    let release: (() => void) | null = null;
    const attach = () => {
      const overlay = container.querySelector('[data-chat-composer-overlay="true"]');
      if (overlay === null || release !== null) return;
      release = observeResize(overlay, () => setHeight(overlay.getBoundingClientRect().height));
    };
    attach();
    const mutations = new MutationObserver(attach);
    mutations.observe(container, { childList: true, subtree: true });
    return () => {
      mutations.disconnect();
      release?.();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the board how much room to leave under its cards
  useEffect(() => onHeightChange(height ?? 0), [height, onHeightChange]);

  return (
    // Only the composer floats over the board and takes clicks; the board shows around it.
    <section
      aria-label="Router"
      ref={chatRef}
      data-side-chat-pane
      className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col overflow-hidden *:bg-transparent [&_[data-chat-workspace-drop-target]>:not([data-chat-composer-overlay])]:invisible"
      style={{ height: height === null ? "9rem" : `${height}px` }}
      onSubmitCapture={noteSend}
      onKeyDownCapture={(event) => {
        if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) noteSend();
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
    </section>
  );
}
