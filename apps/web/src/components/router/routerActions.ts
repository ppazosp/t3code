import type { WorkLogEntry } from "../../session-logic";

/** What the router did in a turn, shown in place of the empty reply it is told to leave. */
export type RouterAction =
  | { readonly kind: "started"; readonly title: string; readonly threadId: string | null }
  | { readonly kind: "proposed"; readonly title: string; readonly proposalId: string }
  | { readonly kind: "routed"; readonly threadId: string }
  | { readonly kind: "replied"; readonly text: string };

const ROUTER_TOOL = /(?:^|[._])(dispatch_worker|route_to_thread|channel_reply)$/u;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value : null);

/** A tool's result as data: Codex passes the object, Claude MCP content blocks of JSON text. */
function resultData(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (depth > 4) return undefined;
  if (typeof value === "string") {
    try {
      return resultData(JSON.parse(value), depth + 1);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const data = resultData(asRecord(block)?.text ?? block, depth + 1);
      if (data !== undefined) return data;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (record === undefined || record.isError === true || record.is_error === true) return undefined;
  const content = record.structuredContent ?? record.content;
  return content === undefined ? record : resultData(content, depth + 1);
}

/** One completed router tool call, read from its turn item; anything else is null. */
function routerActionOf(entry: WorkLogEntry): RouterAction | null {
  const item = entry.structuredPayload;
  if (item?.type !== "dynamic_tool" || item.status !== "completed") return null;
  const tool = ROUTER_TOOL.exec(item.toolName ?? "")?.[1];
  if (tool === undefined) return null;
  const input = asRecord(item.input) ?? {};
  const output = resultData(item.output);
  if (item.output !== undefined && output === undefined) return null;
  switch (tool) {
    case "dispatch_worker": {
      const title = text(input.title) ?? "Worker";
      // Clients get only ids of a result: a proposal's scheduledTaskId, a started worker's threadId.
      const proposalId = text(output?.scheduledTaskId);
      return proposalId !== null
        ? { kind: "proposed", title, proposalId }
        : { kind: "started", title, threadId: text(output?.threadId) };
    }
    case "route_to_thread": {
      const threadId = text(input.threadId);
      return threadId === null ? null : { kind: "routed", threadId };
    }
    default: {
      const reply = text(input.text);
      return reply === null ? null : { kind: "replied", text: reply };
    }
  }
}

/** The router actions of each run, in order. */
export function routerActionsByRun(
  entries: ReadonlyArray<WorkLogEntry>,
): ReadonlyMap<string, ReadonlyArray<RouterAction>> {
  const byRun = new Map<string, RouterAction[]>();
  for (const entry of entries) {
    if (entry.runId == null) continue;
    const action = routerActionOf(entry);
    if (action === null) continue;
    const actions = byRun.get(entry.runId) ?? [];
    actions.push(action);
    byRun.set(entry.runId, actions);
  }
  return byRun;
}

export function sameRouterActions(
  a: ReadonlyArray<RouterAction> | undefined,
  b: ReadonlyArray<RouterAction> | undefined,
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((action, index) => JSON.stringify(action) === JSON.stringify(b[index]));
}
