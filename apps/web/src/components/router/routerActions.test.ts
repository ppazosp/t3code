import { describe, expect, it } from "vite-plus/test";

import type { WorkLogEntry } from "../../session-logic";
import { routerActionsByRun } from "./routerActions";

const call = (
  runId: string,
  toolName: string,
  input: unknown,
  output?: unknown,
  status = "completed",
) =>
  ({
    id: `${runId}:${toolName}`,
    createdAt: "",
    runId,
    label: toolName,
    tone: "tool",
    structuredPayload: { type: "dynamic_tool", status, toolName, input, output },
  }) as unknown as WorkLogEntry;

describe("routerActionsByRun", () => {
  it("reads router tool calls as Codex and Claude report them", () => {
    const actions = routerActionsByRun([
      // Codex: a namespaced name and the result as an object.
      call(
        "r1",
        "t3-code.dispatch_worker",
        { title: "Fix export" },
        { outcome: "started", threadId: "t1" },
      ),
      // Claude: an MCP name and the result as JSON text blocks.
      call("r1", "mcp__t3-code__dispatch_worker", { title: "Scope it" }, [
        { type: "text", text: '{"outcome":"proposed","scheduledTaskId":"scheduled-task:p1"}' },
      ]),
      call("r1", "t3-code.route_to_thread", { threadId: "t2", note: "same bug" }, { routed: true }),
      call("r2", "t3-code.channel_reply", { ref: "slack:C1:1", text: "On it" }, { posted: true }),
      // What clients get on the wire: only the result's ids.
      call("r3", "t3-code.dispatch_worker", { title: "Wire" }, { scheduledTaskId: "st:p2" }),
      // Failed, unfinished and unrelated calls show nothing.
      call("r2", "t3-code.dispatch_worker", { title: "x" }, { isError: true, content: "no" }),
      call("r2", "t3-code.dispatch_worker", { title: "y" }, undefined, "inProgress"),
      call("r2", "t3-code.t3_thread_list", {}, {}),
    ]);
    expect(actions.get("r1")).toEqual([
      { kind: "started", title: "Fix export", threadId: "t1" },
      { kind: "proposed", title: "Scope it", proposalId: "scheduled-task:p1" },
      { kind: "routed", threadId: "t2" },
    ]);
    expect(actions.get("r2")).toEqual([{ kind: "replied", text: "On it" }]);
    expect(actions.get("r3")).toEqual([{ kind: "proposed", title: "Wire", proposalId: "st:p2" }]);
  });
});
