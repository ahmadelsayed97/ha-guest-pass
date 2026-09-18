import type { Server } from "bun";
import type { Config } from "./config.ts";
import { bearerToken, type Authenticator, type Session } from "./guest-auth.ts";
import { GUEST_PAGE_HTML } from "./guest-page.ts";
import { classifyRequest } from "./http-policy.ts";
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

function notFound(): Response {
  return new Response("Not found", { status: 404 });
}

export function createServer(config: Config, auth: Authenticator, opts: ServerOptions = {}): Server<GuestSocketData> {
  const log = opts.log ?? consoleLogger;
  const requestIP = opts.requestIP ?? ((req, server) => server.requestIP(req)?.address ?? null);
  const websocket = createWebSocketHandler(config, auth, log);
  const isDashboard = (urlPath: string) => auth.dashboards().includes(urlPath);

  function sessionFor(req: Request): Session | null {
    return auth.authenticate(bearerToken(req.headers.get("authorization")));
  }

  async function handleAuthToken(req: Request): Promise<Response> {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (form.get("action") === "revoke") return new Response(null, { status: 200 });
    if (form.get("grant_type") !== "refresh_token") return json({ error: "unsupported_grant_type" }, 400);
    const refreshToken = form.get("refresh_token");
    if (!auth.authenticate(refreshToken)) return json({ error: "invalid_grant" }, 400);
    return json({ access_token: refreshToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_LIFETIME_SECONDS });
  }

  function handleGuestSession(req: Request): Response {
    const session = sessionFor(req);
    if (!session) return json({ message: "Unauthorized" }, 401);
    return json({ name: session.user.name, dashboards: session.scope.dashboards() });
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

      const path = new URL(req.url).pathname;

      if (path === "/guest") {
        return new Response(GUEST_PAGE_HTML, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (path === "/guest/session") return handleGuestSession(req);
      if (path === "/auth/token") return handleAuthToken(req);
      if (path === "/api/websocket") {
        return server.upgrade(req, { data: initialSocketData() }) ? undefined : new Response("Upgrade required", { status: 426 });
      }

      const kind = classifyRequest(req.method, path, isDashboard);
      if (kind === "static") return forwardToHA(req, config, { withToken: false });
      if (kind === "deny") {
        log("warn", "rest denied", { method: req.method, path });
        return notFound();
      }

      const session = sessionFor(req);
      if (!session) {
        log("warn", "rest guest auth rejected", { method: req.method, path });
        return json({ message: "Unauthorized" }, 401);
      }
      if (!session.scope.canView(kind.entityId)) {
        log("warn", "rest denied", { method: req.method, path });
        return notFound();
      }
      return forwardToHA(req, config, { withToken: true });
    },
  });
}
