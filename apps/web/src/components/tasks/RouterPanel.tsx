import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useNavigate } from "@tanstack/react-router";
import { Maximize2Icon, MinusIcon, RouteIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import type { SideChatParentPanel } from "../../lib/sideChatPane";
import { buildThreadRouteParams } from "../../threadRoutes";
import ChatView from "../ChatView";
import { BackgroundThreadContext } from "../chat/backgroundThread";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { TaskStatusPill } from "./TaskPresentation";
import { resolveTaskStatus } from "./tasks.logic";

const PANEL_SIZE = {
  width: "min(28rem, calc(100% - 2rem))",
  height: "min(40rem, calc(100% - 2rem))",
};

/**
 * The router's own chat, floating over the board's corner like Linear's agent: T3's composer with
 * its model, mode and attachment controls, and the conversation above it. Hidden, it folds into a
 * button. It stays mounted while hidden, so a draft and the scroll position survive.
 */
export function RouterPanel({
  router,
  now,
  composerRef,
  open,
  onOpenChange,
}: {
  router: EnvironmentThreadShell;
  now: string;
  composerRef: ComposerHandleRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
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

  return (
    <>
      {open ? null : (
        <Button
          variant="outline"
          className="absolute right-4 bottom-4 z-20 sm:right-6"
          onClick={() => onOpenChange(true)}
        >
          <RouteIcon aria-hidden />
          Router
          <TaskStatusPill task={task} />
        </Button>
      )}
      <section
        aria-label="Router"
        hidden={!open}
        className="absolute right-4 bottom-4 z-20 flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl sm:right-6"
        style={PANEL_SIZE}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border/70 pr-2 pl-4 text-sm">
          <RouteIcon aria-hidden className="size-3.5 text-muted-foreground" />
          <h2 className="font-medium">Router</h2>
          <TaskStatusPill task={task} />
          <span className="ml-auto flex items-center gap-0.5">
            <PanelButton label="Open the full conversation" onClick={openRouter}>
              <Maximize2Icon />
            </PanelButton>
            <PanelButton label="Hide the router" onClick={() => onOpenChange(false)}>
              <MinusIcon />
            </PanelButton>
          </span>
        </header>
        <div data-side-chat-pane className="relative flex min-h-0 flex-1 flex-col">
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
    </>
  );
}

function PanelButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-xs" variant="ghost-muted" aria-label={label} onClick={onClick} />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
