// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - A stand-in Slack for tests and manual runs, outside any Effect program.
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeWS from "@effect/platform-node/NodeWS";

/**
 * A stand-in for Slack, for tests and for trying super-t3 without a Slack app: the Web API methods
 * the adapter calls, Socket Mode over a local WebSocket, and a control API that writes and presses Stop as
 * a person would. Its page at `/` shows the conversations as they change.
 *
 * Point super-t3 at it with `T3_SLACK_API_URL=<url>/api` and any tokens.
 */

export const MOCK_BOT_USER = "UBOT";
const MOCK_TEAM = "TMOCK";

export interface MockMessage {
  readonly channel: string;
  readonly ts: string;
  readonly threadTs: string | null;
  readonly user: string | null;
  text: string;
  blocks: ReadonlyArray<Record<string, unknown>> | null;
  readonly reactions: Set<string>;
  edits: number;
}

export interface MockCall {
  readonly method: string;
  readonly args: Record<string, unknown>;
}

export interface MockSlack {
  readonly url: string;
  readonly calls: ReadonlyArray<MockCall>;
  readonly messages: ReadonlyArray<MockMessage>;
  /** How many Socket Mode connections are open. */
  readonly connections: () => number;
  /** The status super-t3 last set on each agent session, by `channel:thread_ts`. */
  readonly statuses: ReadonlyMap<string, string>;
  /** A person writes a message; returns its ts. */
  readonly say: (input: {
    readonly user: string;
    readonly channel: string;
    readonly text: string;
    readonly threadTs?: string;
    readonly dm?: boolean;
  }) => string;
  /** A person presses Stop on an agent session in Slack's agent panel. */
  readonly stop: (input: {
    readonly user: string;
    readonly channel: string;
    readonly threadTs: string;
  }) => void;
  /** Waits until `check` holds, polling the recorded state. */
  readonly until: <A>(check: () => A | undefined | null | false, timeoutMs?: number) => Promise<A>;
  readonly close: () => Promise<void>;
}

const NAMES: Record<string, string> = {
  UME: "Pablo",
  UMARIA: "Maria López",
  UDIEGO: "Diego Ruiz",
  CENG: "eng",
  CWATCH: "eng",
  COTHER: "random",
};

export function startMockSlack(options: { readonly port?: number } = {}): Promise<MockSlack> {
  const calls: Array<MockCall> = [];
  const messages: Array<MockMessage> = [];
  const statuses = new Map<string, string>();
  const sockets = new Set<NodeWS.WebSocket>();
  // Seeded from the wall clock, like Slack, so a restarted mock never repeats a message id.
  let clock = Math.floor(Date.now() / 1000);
  let seq = 0;
  const nextTs = () => `${++clock}.${String(++seq).padStart(6, "0")}`;
  const find = (channel: string, ts: string) =>
    messages.find((message) => message.channel === channel && message.ts === ts);

  const emit = (type: string, payload: unknown) => {
    const frame = JSON.stringify({ type, envelope_id: `env-${++seq}`, payload });
    for (const socket of sockets) socket.send(frame);
  };

  const say: MockSlack["say"] = ({ user, channel, text, threadTs, dm }) => {
    const ts = nextTs();
    messages.push({
      channel,
      ts,
      threadTs: threadTs ?? null,
      user,
      text,
      blocks: null,
      reactions: new Set(),
      edits: 0,
    });
    const event = {
      type: "message",
      channel,
      channel_type: dm === true ? "im" : "channel",
      user,
      text,
      ts,
      ...(threadTs === undefined ? {} : { thread_ts: threadTs }),
    };
    emit("events_api", { team_id: MOCK_TEAM, event });
    if (dm !== true && text.includes(`<@${MOCK_BOT_USER}>`)) {
      emit("events_api", { team_id: MOCK_TEAM, event: { ...event, type: "app_mention" } });
    }
    return ts;
  };

  const stop: MockSlack["stop"] = ({ user, channel, threadTs }) => {
    emit("events_api", {
      team_id: MOCK_TEAM,
      event: { type: "agent_session_stopped", user, channel, thread_ts: threadTs },
    });
  };

  const api = (method: string, args: Record<string, unknown>): Record<string, unknown> => {
    calls.push({ method, args });
    const channel = String(args.channel ?? "");
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: MOCK_BOT_USER, team_id: MOCK_TEAM };
      case "apps.connections.open":
        return { ok: true, url: `${state.url.replace(/^http/u, "ws")}/socket` };
      case "chat.postMessage": {
        const ts = nextTs();
        messages.push({
          channel,
          ts,
          threadTs: typeof args.thread_ts === "string" ? args.thread_ts : null,
          user: MOCK_BOT_USER,
          text: String(args.text ?? ""),
          blocks: (args.blocks as Array<Record<string, unknown>> | undefined) ?? null,
          reactions: new Set(),
          edits: 0,
        });
        return { ok: true, channel, ts };
      }
      case "chat.update": {
        const message = find(channel, String(args.ts));
        if (message === undefined) return { ok: false, error: "message_not_found" };
        message.text = String(args.text ?? "");
        message.blocks = (args.blocks as Array<Record<string, unknown>> | undefined) ?? null;
        message.edits += 1;
        return { ok: true, channel, ts: message.ts };
      }
      case "reactions.add":
      case "reactions.remove": {
        const message = find(channel, String(args.timestamp));
        if (message === undefined) return { ok: false, error: "message_not_found" };
        const name = String(args.name);
        if (method === "reactions.add") {
          if (message.reactions.has(name)) return { ok: false, error: "already_reacted" };
          message.reactions.add(name);
        } else if (!message.reactions.delete(name)) {
          return { ok: false, error: "no_reaction" };
        }
        return { ok: true };
      }
      case "conversations.info":
        return {
          ok: true,
          channel: { id: channel, name: NAMES[channel] ?? channel.toLowerCase() },
        };
      case "users.info": {
        const user = String(args.user);
        return { ok: true, user: { id: user, profile: { display_name: NAMES[user] ?? user } } };
      }
      case "conversations.replies": {
        const root = String(args.ts);
        const thread = messages.filter(
          (message) =>
            message.channel === channel && (message.ts === root || message.threadTs === root),
        );
        return {
          ok: true,
          messages: thread.map((message) => ({
            ts: message.ts,
            text: message.text,
            ...(message.user === MOCK_BOT_USER ? { bot_id: "BMOCK" } : { user: message.user }),
          })),
        };
      }
      case "agents.sessions.setStatus":
        statuses.set(`${String(args.channel_id)}:${String(args.thread_ts)}`, String(args.status));
        return { ok: true };
      default:
        return { ok: false, error: "unknown_method" };
    }
  };

  /** Only requests addressed to this server, so a rebound DNS name cannot reach it from a page. */
  const isOwnHost = (request: NodeHttp.IncomingMessage) => {
    const port = new URL(state.url).port;
    return (
      request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`
    );
  };

  /**
   * The control API writes and presses Stop as the user, so a page on another site must not reach it: a
   * browser sends its origin, and a JSON body forces a preflight this server never answers.
   */
  const isOwnPost = (request: NodeHttp.IncomingMessage) => {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== state.url) return false;
    return (
      request.method === "POST" &&
      (request.headers["content-type"] ?? "").startsWith("application/json")
    );
  };

  const readBody = (request: NodeHttp.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let body = "";
      request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
      request.on("end", () => resolve(body));
    });

  const send = (
    response: NodeHttp.ServerResponse,
    status: number,
    body: unknown,
    type = "application/json",
  ) => {
    response.writeHead(status, { "content-type": type });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };

  const server = NodeHttp.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://mock");
      if (!isOwnHost(request)) return send(response, 403, { ok: false, error: "forbidden" });
      const raw = await readBody(request);
      let body: Record<string, unknown> = {};
      if (raw !== "") {
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          body = Object.fromEntries(new URLSearchParams(raw));
        }
      }
      try {
        if (url.pathname.startsWith("/api/")) {
          return send(
            response,
            200,
            api(url.pathname.slice(5), {
              ...Object.fromEntries(url.searchParams),
              ...body,
            }),
          );
        }
        const control = ["/_mock/say", "/_mock/stop"];
        if (control.includes(url.pathname) && !isOwnPost(request)) {
          return send(response, 403, { ok: false, error: "forbidden" });
        }
        // What the control API acts on comes only from its JSON body.
        if (url.pathname === "/_mock/say") return send(response, 200, { ts: say(body as never) });
        if (url.pathname === "/_mock/stop") {
          stop(body as never);
          return send(response, 200, { ok: true });
        }
        if (url.pathname === "/_mock/state") {
          return send(response, 200, {
            connected: sockets.size,
            calls,
            messages: messages.map((message) => ({
              ...message,
              reactions: [...message.reactions],
            })),
            statuses: Object.fromEntries(statuses),
          });
        }
        if (url.pathname === "/") return send(response, 200, PAGE, "text/html; charset=utf-8");
        return send(response, 404, { ok: false, error: "not_found" });
      } catch (error) {
        return send(response, 400, { ok: false, error: String(error) });
      }
    })();
  });

  const sockets_ = new NodeWS.WebSocketServer({ server, path: "/socket" });
  sockets_.on("connection", (socket) => {
    sockets.add(socket);
    socket.send(JSON.stringify({ type: "hello" }));
    socket.on("close", () => sockets.delete(socket));
  });

  const state = { url: "" };
  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      state.url = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
      resolve({
        url: state.url,
        calls,
        messages,
        connections: () => sockets.size,
        statuses,
        stop,
        say,
        until: async (check, timeoutMs = 10_000) => {
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const value = check();
            if (value !== undefined && value !== null && value !== false) return value;
            await new Promise((wait) => setTimeout(wait, 25));
          }
          throw new Error("The mock Slack never reached the expected state");
        },
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.terminate();
            sockets_.close();
            server.close(() => done());
          }),
      });
    });
  });
}

/** A small Slack-like view of the mock's conversations, refreshed every second. */
const PAGE = `<!doctype html>
<meta charset="utf-8" />
<title>Mock Slack</title>
<style>
  :root { color-scheme: dark; font: 14px/1.45 -apple-system, system-ui, sans-serif; }
  body { margin: 0; background: #1a1d21; color: #d1d2d3; }
  header { padding: 12px 20px; border-bottom: 1px solid #333; font-weight: 700; color: #fff; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; padding: 16px; }
  section { background: #222529; border: 1px solid #333; border-radius: 8px; padding: 12px; }
  h2 { margin: 0 0 8px; font-size: 13px; color: #aaa; }
  .msg { padding: 6px 0; border-top: 1px solid #2c2f33; }
  .reply { margin-left: 20px; }
  .who { font-weight: 700; color: #fff; margin-right: 6px; }
  .bot { color: #7fb4ff; }
  .card { margin: 3px 0 3px 8px; }
  .md { white-space: pre-wrap; background: #1a1d21; border-radius: 6px; padding: 8px; margin: 4px 0; }
  .ctx { color: #999; font-size: 12px; }
  .reactions { font-size: 12px; color: #bbb; }
  button { margin-right: 6px; border-radius: 4px; border: 1px solid #555; background: #2c2f33; color: #fff; padding: 3px 10px; }
  button.primary { background: #007a5a; border-color: #007a5a; }
  form { display: flex; gap: 6px; padding: 12px 20px; }
  input { flex: 1; background: #222529; color: #fff; border: 1px solid #444; border-radius: 6px; padding: 6px; }
</style>
<header>Mock Slack</header>
<form id="say"><input name="text" placeholder="DM super-t3 as you (UME)" /><button>Send</button></form>
<main id="main"></main>
<script>
const JSON_HEADERS = { "content-type": "application/json" };
const icon = { complete: "✅", in_progress: "⏳", error: "⚠️" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reacts = { eyes: "👀", white_check_mark: "✅" };
function blocks(m) {
  if (!m.blocks) return '<div>' + esc(m.text) + '</div>';
  return m.blocks.map((b) => {
    if (b.type === "section") return '<div>' + esc(b.text.text) + '</div>';
    if (b.type === "task_card") return '<div class="card">' + (icon[b.status] ?? "•") + ' ' + esc(b.title) + '</div>';
    if (b.type === "markdown") return '<div class="md">' + esc(b.text) + '</div>';
    if (b.type === "rich_text") return '<div class="md">' + esc(b.elements[0].elements[0].text) + '</div>';
    if (b.type === "context") return '<div class="ctx">' + esc(b.elements[0].text) + '</div>';
    if (b.type === "data_visualization") return '<div class="md">📊 ' + esc(b.title) + ' (' + esc(b.chart.type) + ' chart)</div>';
    return "";
  }).join("");
}
async function render() {
  const state = await (await fetch("/_mock/state")).json();
  const byChannel = {};
  for (const m of state.messages) (byChannel[m.channel] ??= []).push(m);
  document.getElementById("main").innerHTML = Object.entries(byChannel).map(([c, ms]) =>
    '<section><h2>' + esc(c) + '</h2>' + ms.map((m) =>
      '<div class="msg ' + (m.threadTs && m.threadTs !== m.ts ? "reply" : "") + '"><span class="who ' + (m.user === "UBOT" ? "bot" : "") + '">' + (m.user === "UBOT" ? "super-t3" : esc(m.user)) + '</span>' + blocks(m) +
      (m.reactions.length ? '<div class="reactions">' + m.reactions.map((r) => reacts[r] ?? r).join(" ") + '</div>' : "") + '</div>').join("") + '</section>').join("");
}
document.getElementById("say").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = e.target.text.value;
  e.target.text.value = "";
  await fetch("/_mock/say", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ user: "UME", channel: "DME", text, dm: true }) });
});
render();
setInterval(render, 1000);
</script>`;
