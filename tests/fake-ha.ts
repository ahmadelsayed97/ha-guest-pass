import type { Server, ServerWebSocket } from "bun";

export interface FakeHA {
  server: Server<undefined>;
  url: URL;
  token: string;
  haVersion: string;
  states: Array<{ entity_id: string; state: string; attributes: Record<string, unknown> }>;
  wsAuthTokens: string[];
  wsConnections: number;
  received: Array<Record<string, unknown>>;
  httpAuth: Array<{ path: string; authorization: string | null }>;
  broadcast(frame: string): void;
  stop(): void;
}

export function startFakeHA(token = "REAL-HA-TOKEN-" + crypto.randomUUID()): FakeHA {
  const haVersion = "2026.9.1";
  const sockets = new Set<ServerWebSocket<undefined>>();
  const state = {
    token,
    haVersion,
    states: [
      { entity_id: "light.kitchen", state: "on", attributes: { friendly_name: "Kitchen" } },
      { entity_id: "light.bedroom", state: "off", attributes: { friendly_name: "Bedroom" } },
      { entity_id: "sensor.temp", state: "21", attributes: {} },
      { entity_id: "lock.front", state: "locked", attributes: { code: "1234" } },
    ],
    wsAuthTokens: [] as string[],
    wsConnections: 0,
    received: [] as Array<Record<string, unknown>>,
    httpAuth: [] as Array<{ path: string; authorization: string | null }>,
  };

  const server = Bun.serve<undefined>({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req, srv) {
      const url = new URL(req.url);
      state.httpAuth.push({ path: url.pathname, authorization: req.headers.get("authorization") });
      if (url.pathname === "/api/websocket") {
        return srv.upgrade(req) ? undefined : new Response("nope", { status: 400 });
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.get("authorization") !== `Bearer ${token}`) {
          return Response.json({ message: "Unauthorized" }, { status: 401 });
        }
        return Response.json({
          path: url.pathname,
          method: req.method,
          origin: req.headers.get("origin"),
          xff: req.headers.get("x-forwarded-for"),
        });
      }
      if (url.pathname === "/auth/authorize") return new Response("HA login page");
      return new Response(`<html>HA index ${url.pathname}</html>`, { headers: { "content-type": "text/html" } });
    },
    websocket: {
      open(ws) {
        state.wsConnections++;
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "auth_required", ha_version: haVersion }));
      },
      close(ws) {
        sockets.delete(ws);
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw)) as Record<string, unknown>;
        if (msg.type === "auth") {
          state.wsAuthTokens.push(String(msg.access_token));
          if (msg.access_token === token) {
            ws.send(JSON.stringify({ type: "auth_ok", ha_version: haVersion }));
          } else {
            ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token or password" }));
            ws.close(1000);
          }
          return;
        }
        state.received.push(msg);
        const result = (value: unknown) => ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: value }));
        switch (msg.type) {
          case "ping":
            ws.send(JSON.stringify({ id: msg.id, type: "pong" }));
            return;
          case "get_states":
            result(state.states);
            return;
          case "subscribe_entities": {
            result(null);
            const a = Object.fromEntries(state.states.map((s) => [s.entity_id, { s: s.state, a: s.attributes }]));
            ws.send(JSON.stringify({ id: msg.id, type: "event", event: { a } }));
            return;
          }
          case "call_service":
            result({ context: { id: "ctx" }, response: { secret: true } });
            return;
          default:
            result({ echo: msg });
        }
      },
    },
  });

  return Object.assign(state, {
    server,
    url: new URL(`http://127.0.0.1:${server.port}`),
    broadcast: (frame: string) => {
      for (const ws of sockets) ws.send(frame);
    },
    stop: () => server.stop(true),
  });
}
