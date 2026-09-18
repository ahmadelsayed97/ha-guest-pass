import type { Server } from "bun";
import type { Config } from "./config.ts";
import { bearerToken, isValidGuestToken } from "./guest-auth.ts";
import { GUEST_PAGE_HTML } from "./guest-page.ts";
import { forwardToHA } from "./http-proxy.ts";
import { isLanAddress } from "./lan.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { createWebSocketHandler, initialSocketData, type GuestSocketData } from "./ws-proxy.ts";

export interface ServerOptions {
  log?: Logger;
  port?: number;
  requestIP?: (req: Request, server: Server<GuestSocketData>) => string | null;
}

const ACCESS_TOKEN_LIFETIME_SECONDS = 1800;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function createServer(config: Config, opts: ServerOptions = {}): Server<GuestSocketData> {
  const log = opts.log ?? consoleLogger;
  const requestIP = opts.requestIP ?? ((req, server) => server.requestIP(req)?.address ?? null);
  const websocket = createWebSocketHandler(config, log);

  async function handleAuthToken(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (form.get("action") === "revoke") {
      return new Response(null, { status: 200 });
    }
    if (form.get("grant_type") !== "refresh_token") return json({ error: "unsupported_grant_type" }, 400);
    const refreshToken = form.get("refresh_token");
    if (!isValidGuestToken(refreshToken, config.guestSecret)) return json({ error: "invalid_grant" }, 400);
    return json({
      access_token: refreshToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
    });
  }

  return Bun.serve<GuestSocketData>({
    hostname: config.host,
    port: opts.port ?? config.port,
    websocket,
    async fetch(req, server) {
      const ip = requestIP(req, server);
      if (!isLanAddress(ip)) {
        log("warn", "rejected non-LAN request", { ip });
        return new Response("Forbidden", { status: 403 });
      }

      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/guest") {
        return new Response(GUEST_PAGE_HTML, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (path === "/auth/token") return handleAuthToken(req);
      if (path.startsWith("/auth/")) {
        return new Response("Not found", { status: 404 });
      }

      if (path === "/api/websocket") {
        const upgraded = server.upgrade(req, { data: initialSocketData() });
        if (upgraded) return undefined;
        return new Response("WebSocket upgrade required", { status: 426 });
      }

      if (path === "/api" || path.startsWith("/api/")) {
        const presented = bearerToken(req.headers.get("authorization"));
        if (!isValidGuestToken(presented, config.guestSecret)) {
          log("warn", "rest guest auth rejected", { method: req.method, path });
          return json({ message: "Unauthorized" }, 401);
        }
        log("info", "rest forward", { method: req.method, path });
        return forwardToHA(req, config, { withToken: true });
      }

      log("info", "static forward", { method: req.method, path });
      return forwardToHA(req, config, { withToken: false });
    },
  });
}
