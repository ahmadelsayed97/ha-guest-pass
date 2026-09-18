import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Config } from "./config.ts";
import { isValidGuestToken } from "./guest-auth.ts";
import type { Logger } from "./log.ts";

type State = "awaiting_auth" | "connecting" | "relaying" | "closed";

export interface GuestSocketData {
  state: State;
  upstream: WebSocket | null;
  pending: string[];
}

export type GuestSocket = ServerWebSocket<GuestSocketData>;

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;

export function initialSocketData(): GuestSocketData {
  return { state: "awaiting_auth", upstream: null, pending: [] };
}

export function haWebSocketUrl(haUrl: URL): string {
  const ws = new URL("/api/websocket", haUrl);
  ws.protocol = haUrl.protocol === "https:" ? "wss:" : "ws:";
  return ws.toString();
}

export function createWebSocketHandler(config: Config, log: Logger): WebSocketHandler<GuestSocketData> {
  const upstreamUrl = haWebSocketUrl(config.haUrl);
  let lastSeenHaVersion = "unknown";

  function closeGuest(ws: GuestSocket, code: number, reason: string): void {
    if (ws.data.state === "closed") return;
    ws.data.state = "closed";
    const upstream = ws.data.upstream;
    ws.data.upstream = null;
    ws.data.pending = [];
    if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close(1000);
    ws.close(code, reason);
  }

  function connectUpstream(ws: GuestSocket): void {
    ws.data.state = "connecting";
    const upstream = new WebSocket(upstreamUrl);
    ws.data.upstream = upstream;
    let upstreamAuthed = false;

    upstream.onmessage = (event) => {
      if (ws.data.state === "closed" || ws.data.upstream !== upstream) return;
      if (typeof event.data !== "string") {
        log("warn", "ws upstream sent binary frame; closing");
        closeGuest(ws, CLOSE_INTERNAL_ERROR, "unexpected upstream frame");
        return;
      }
      if (upstreamAuthed) {
        ws.send(event.data);
        return;
      }
      let msg: { type?: unknown; ha_version?: unknown };
      try {
        msg = JSON.parse(event.data);
      } catch {
        closeGuest(ws, CLOSE_INTERNAL_ERROR, "bad upstream handshake");
        return;
      }
      switch (msg.type) {
        case "auth_required":
          upstream.send(JSON.stringify({ type: "auth", access_token: config.haToken }));
          return;
        case "auth_ok": {
          upstreamAuthed = true;
          if (typeof msg.ha_version === "string") lastSeenHaVersion = msg.ha_version;
          ws.data.state = "relaying";
          ws.send(JSON.stringify({ type: "auth_ok", ha_version: lastSeenHaVersion }));
          for (const frame of ws.data.pending) upstream.send(frame);
          ws.data.pending = [];
          return;
        }
        default:
          log("error", "ws upstream auth failed", { type: String(msg.type) });
          closeGuest(ws, CLOSE_INTERNAL_ERROR, "upstream auth failed");
      }
    };
    upstream.onerror = () => {
      log("error", "ws upstream error");
      closeGuest(ws, CLOSE_INTERNAL_ERROR, "upstream error");
    };
    upstream.onclose = (event) => {
      if (ws.data.upstream !== upstream) return;
      log("info", "ws upstream closed", { code: event.code });
      closeGuest(ws, 1000, "upstream closed");
    };
  }

  return {
    open(ws) {
      ws.send(JSON.stringify({ type: "auth_required", ha_version: lastSeenHaVersion }));
    },

    message(ws, raw) {
      if (ws.data.state === "closed") return;
      if (typeof raw !== "string") {
        closeGuest(ws, CLOSE_POLICY_VIOLATION, "binary frames not allowed");
        return;
      }

      if (ws.data.state === "awaiting_auth") {
        let msg: { type?: unknown; access_token?: unknown };
        try {
          msg = JSON.parse(raw);
        } catch {
          closeGuest(ws, CLOSE_POLICY_VIOLATION, "invalid message");
          return;
        }
        if (msg.type !== "auth") {
          closeGuest(ws, CLOSE_POLICY_VIOLATION, "auth required");
          return;
        }
        if (!isValidGuestToken(msg.access_token, config.guestSecret)) {
          log("warn", "ws guest auth rejected", { ip: ws.remoteAddress });
          ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
          closeGuest(ws, CLOSE_POLICY_VIOLATION, "invalid auth");
          return;
        }
        log("info", "ws guest authenticated", { ip: ws.remoteAddress });
        connectUpstream(ws);
        return;
      }

      if (isAuthFrame(raw)) {
        closeGuest(ws, CLOSE_POLICY_VIOLATION, "unexpected auth");
        return;
      }
      if (ws.data.state === "connecting") {
        ws.data.pending.push(raw);
        return;
      }
      ws.data.upstream?.send(raw);
    },

    close(ws) {
      closeGuest(ws, 1000, "guest closed");
    },
  };
}

function isAuthFrame(raw: string): boolean {
  try {
    const msg = JSON.parse(raw);
    return typeof msg === "object" && msg !== null && msg.type === "auth";
  } catch {
    return true;
  }
}
