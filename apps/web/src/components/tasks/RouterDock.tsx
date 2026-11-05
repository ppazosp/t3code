import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronUpIcon, RouteIcon, SquareArrowOutUpRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { observeResize } from "~/lib/observeResize";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskStatusPill } from "./TaskPresentation";
import { resolveTaskColumn } from "./tasks.logic";

const EXPANDED_HEIGHT = "min(30rem, 55dvh)";

/**
 * The router's own chat, docked under the board: T3's composer with its model, mode and
 * attachment controls. Collapsed, only the composer shows; expanded, the conversation above it.
 * It runs as an embedded chat, so the board keeps the keyboard and the page layout.
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
  const [expanded, setExpanded] = useState(false);
  const [composerHeight, setComposerHeight] = useState<number | null>(null);
  const chatRef = useRef<HTMLDivElement | null>(null);
  const routerRef = scopeThreadRef(router.environmentId, router.id);
  const task = {
    key: router.id,
    thread: router,
    column: resolveTaskColumn(router, now),
    subtasks: [],
  };

  const openRouter = () =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(routerRef) });
  // The router cannot run commands; its diffs and links open in its full conversation.
  const parentPanel: SideChatParentPanel = {
    openToolDiff: openRouter,
    runShellCommand: () => {},
  };

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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost-muted"
                  aria-label={expanded ? "Hide the conversation" : "Show the conversation"}
                  aria-expanded={expanded}
                  onClick={() => setExpanded(!expanded)}
                />
              }
            >
              {expanded ? <ChevronDownIcon /> : <ChevronUpIcon />}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {expanded ? "Hide the conversation" : "Show the conversation"}
            </TooltipPopup>
          </Tooltip>
        </span>
      </div>
      <div
        ref={chatRef}
        data-side-chat-pane
        className={cn(
          "relative flex min-h-0 flex-col overflow-hidden",
          // Collapsed, only the composer shows; the timeline under it stays mounted for expanding.
          !expanded &&
            "[&_[data-chat-workspace-drop-target]>:not([data-chat-composer-overlay])]:invisible",
        )}
        style={{
          height: expanded
            ? EXPANDED_HEIGHT
            : composerHeight === null
              ? "9rem"
              : `${composerHeight}px`,
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
