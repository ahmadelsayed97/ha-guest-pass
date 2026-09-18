import type { Server, ServerWebSocket } from "bun";

export interface FakeHA {
  server: Server<undefined>;
  url: URL;
  token: string;
  haVersion: string;
  wsAuthTokens: string[];
  wsConnections: number;
  httpAuth: Array<{ path: string; authorization: string | null }>;
  stop(): void;
}

export function startFakeHA(token = "REAL-HA-TOKEN-" + crypto.randomUUID()): FakeHA {
  const haVersion = "2026.9.1";
  const state = {
    token,
    haVersion,
    wsAuthTokens: [] as string[],
    wsConnections: 0,
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
      if (url.pathname === "/") {
        return new Response("<html>HA index</html>", { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/auth/authorize") return new Response("HA login page");
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws: ServerWebSocket<undefined>) {
        state.wsConnections++;
        ws.send(JSON.stringify({ type: "auth_required", ha_version: haVersion }));
      },
      message(ws, raw) {
        const msg = JSON.parse(String(raw));
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
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: { echo: msg } }));
      },
    },
  });

  return Object.assign(state, {
    server,
    url: new URL(`http://127.0.0.1:${server.port}`),
    stop: () => server.stop(true),
  });
}
