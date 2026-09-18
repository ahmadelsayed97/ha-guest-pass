import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { Config } from "./config.ts";
import type { Authenticator, Session } from "./guest-auth.ts";
import type { Logger } from "./log.ts";
import { filterOutbound, inspectInbound, LOCAL_SUBSCRIPTION } from "./ws-policy.ts";

type State = "awaiting_auth" | "authenticating" | "connecting" | "relaying" | "closed";

const SUBSCRIPTION_KINDS = new Set(["subscribe_entities", "subscribe_events", LOCAL_SUBSCRIPTION]);

export interface GuestSocketData {
  state: State;
  session: Session | null;
  upstream: WebSocket | null;
  pending: string[];
  kinds: Map<number, string>;
  unsubscribes: Map<number, number>;
  expiryTimer: ReturnType<typeof setTimeout> | null;
}

export type GuestSocket = ServerWebSocket<GuestSocketData>;

export interface GuestBridge {
  handler: WebSocketHandler<GuestSocketData>;
  closeSessionsOf(guestId: string): number;
}

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;

function describe(msg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of ["type", "event_type", "domain", "service"]) if (typeof msg[key] === "string") out[key] = msg[key];
  return out;
}

export function initialSocketData(): GuestSocketData {
  return {
    state: "awaiting_auth",
    session: null,
    upstream: null,
    pending: [],
    kinds: new Map(),
    unsubscribes: new Map(),
    expiryTimer: null,
  };
}

export function haWebSocketUrl(haUrl: URL): string {
  const ws = new URL("/api/websocket", haUrl);
  ws.protocol = haUrl.protocol === "https:" ? "wss:" : "ws:";
  return ws.toString();
}

export function createGuestBridge(config: Config, auth: Authenticator, log: Logger): GuestBridge {
  const upstreamUrl = haWebSocketUrl(config.haUrl);
  const socketsByGuest = new Map<string, Set<GuestSocket>>();
  let lastSeenHaVersion = "unknown";

  function track(ws: GuestSocket, session: Session): void {
    let sockets = socketsByGuest.get(session.user.id);
    if (!sockets) {
      sockets = new Set();
      socketsByGuest.set(session.user.id, sockets);
    }
    sockets.add(ws);
    ws.data.expiryTimer = setTimeout(() => closeGuest(ws, CLOSE_POLICY_VIOLATION, "session expired"), session.expiresAt - Date.now());
  }

  function untrack(ws: GuestSocket): void {
    if (ws.data.expiryTimer) clearTimeout(ws.data.expiryTimer);
    ws.data.expiryTimer = null;
    const guestId = ws.data.session?.user.id;
    if (guestId === undefined) return;
    const sockets = socketsByGuest.get(guestId);
    sockets?.delete(ws);
    if (sockets?.size === 0) socketsByGuest.delete(guestId);
  }

  function closeGuest(ws: GuestSocket, code: number, reason: string): void {
    if (ws.data.state === "closed") return;
    ws.data.state = "closed";
    untrack(ws);
    const upstream = ws.data.upstream;
    ws.data.upstream = null;
    ws.data.pending = [];
    if (upstream && upstream.readyState <= WebSocket.OPEN) upstream.close(1000);
    ws.close(code, reason);
  }

  function relayFromUpstream(ws: GuestSocket, session: Session, frame: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      closeGuest(ws, CLOSE_INTERNAL_ERROR, "bad upstream frame");
      return;
    }
    if (Array.isArray(parsed)) {
      closeGuest(ws, CLOSE_INTERNAL_ERROR, "coalesced upstream frame");
      return;
    }
    const message = filterOutbound(parsed, session, (id) => ws.data.kinds.get(id));
    if (!message) return;
    ws.send(JSON.stringify(message));
    forgetCompleted(ws.data, message);
  }

  function forgetCompleted(data: GuestSocketData, message: Record<string, unknown>): void {
    if (message.type !== "result") return;
    const id = message.id as number;
    const kind = data.kinds.get(id);
    if (kind === "unsubscribe_events") {
      const subscription = data.unsubscribes.get(id);
      if (subscription !== undefined) data.kinds.delete(subscription);
      data.unsubscribes.delete(id);
    }
    if (kind === undefined || SUBSCRIPTION_KINDS.has(kind)) return;
    data.kinds.delete(id);
  }

  function relayToUpstream(ws: GuestSocket, session: Session, raw: string): void {
    if (session.expiresAt <= Date.now()) {
      closeGuest(ws, CLOSE_POLICY_VIOLATION, "session expired");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      closeGuest(ws, CLOSE_POLICY_VIOLATION, "invalid message");
      return;
    }
    const kindOf = (id: number) => ws.data.kinds.get(id);
    const decision = inspectInbound(parsed, session, kindOf);
    switch (decision.action) {
      case "close":
        closeGuest(ws, CLOSE_POLICY_VIOLATION, "invalid message");
        return;
      case "reply":
        if (decision.kind) ws.data.kinds.set(decision.message.id as number, decision.kind);
        if (decision.message.success === false) log("warn", "ws denied", describe(parsed as Record<string, unknown>));
        ws.send(JSON.stringify(decision.message));
        for (const event of decision.events ?? []) ws.send(JSON.stringify(event));
        return;
      case "forward": {
        const id = decision.message.id as number;
        ws.data.kinds.set(id, decision.kind);
        if (decision.kind === "unsubscribe_events") ws.data.unsubscribes.set(id, decision.message.subscription as number);
        const frame = JSON.stringify(decision.message);
        if (ws.data.state === "connecting") ws.data.pending.push(frame);
        else ws.data.upstream?.send(frame);
      }
    }
  }

  function connectUpstream(ws: GuestSocket, session: Session): void {
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
        relayFromUpstream(ws, session, event.data);
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

  async function authenticate(ws: GuestSocket, raw: string): Promise<void> {
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
    ws.data.state = "authenticating";
    const session = await auth.authenticate(msg.access_token);
    if (ws.data.state !== "authenticating") return;
    if (!session) {
      log("warn", "ws guest auth rejected", { ip: ws.remoteAddress });
      ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token" }));
      closeGuest(ws, CLOSE_POLICY_VIOLATION, "invalid auth");
      return;
    }
    log("info", "ws guest authenticated", { ip: ws.remoteAddress, guest: session.user.id });
    ws.data.session = session;
    track(ws, session);
    connectUpstream(ws, session);
  }

  const handler: WebSocketHandler<GuestSocketData> = {
    open(ws) {
      ws.send(JSON.stringify({ type: "auth_required", ha_version: lastSeenHaVersion }));
    },

    message(ws, raw) {
      if (ws.data.state === "closed") return;
      if (typeof raw !== "string") {
        closeGuest(ws, CLOSE_POLICY_VIOLATION, "binary frames not allowed");
        return;
      }
      switch (ws.data.state) {
        case "awaiting_auth":
          void authenticate(ws, raw);
          return;
        case "authenticating":
          closeGuest(ws, CLOSE_POLICY_VIOLATION, "auth in progress");
          return;
        default:
          relayToUpstream(ws, ws.data.session!, raw);
      }
    },

    close(ws) {
      closeGuest(ws, 1000, "guest closed");
    },
  };

  return {
    handler,
    closeSessionsOf(guestId) {
      const sockets = socketsByGuest.get(guestId);
      if (!sockets) return 0;
      const count = sockets.size;
      for (const ws of [...sockets]) closeGuest(ws, CLOSE_POLICY_VIOLATION, "access revoked");
      return count;
    },
  };
}
