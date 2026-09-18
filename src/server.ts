import type { Server } from "bun";
import { handleAdmin, type AdminContext } from "./admin.ts";
import type { Config } from "./config.ts";
import { bearerToken, type Authenticator, type Session } from "./guest-auth.ts";
import type { GuestStore } from "./guest-store.ts";
import { ACCESS_ENDED_HTML, GUEST_PAGE_HTML, NOT_AVAILABLE_HTML } from "./guest-page.ts";
import { classifyRequest } from "./http-policy.ts";
import { forwardToHA } from "./http-proxy.ts";
import { isLanAddress } from "./lan.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { createGuestBridge, initialSocketData, type GuestSocketData } from "./ws-proxy.ts";

export interface ServerDeps {
  auth: Authenticator;
  store: GuestStore;
}

export interface ServerOptions {
  log?: Logger;
  port?: number;
  requestIP?: (req: Request, server: Server<GuestSocketData>) => string | null;
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function notFound(req: Request): Response {
  const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  return wantsPage ? html(NOT_AVAILABLE_HTML, 404) : new Response("Not found", { status: 404 });
}

export function createServer(config: Config, deps: ServerDeps, opts: ServerOptions = {}): Server<GuestSocketData> {
  const { auth, store } = deps;
  const log = opts.log ?? consoleLogger;
  const requestIP = opts.requestIP ?? ((req, server) => server.requestIP(req)?.address ?? null);
  const bridge = createGuestBridge(config, auth, log);
  const isDashboard = (urlPath: string) => auth.dashboards().includes(urlPath);
  const adminContext: AdminContext = { config, store, log, onRevoked: (guestId) => bridge.closeSessionsOf(guestId) };

  function sessionFor(req: Request): Promise<Session | null> {
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
    const session = await auth.authenticate(refreshToken);
    if (!session) return json({ error: "invalid_grant" }, 400);
    const expiresIn = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
    return json({ access_token: refreshToken, token_type: "Bearer", expires_in: expiresIn });
  }

  async function handleGuestSession(req: Request): Promise<Response> {
    const session = await sessionFor(req);
    if (!session) return json({ message: "Unauthorized" }, 401);
    return json({ name: session.user.name, dashboards: session.scope.dashboards(), expiresAt: session.expiresAt });
  }

  return Bun.serve<GuestSocketData>({
    hostname: config.host,
    port: opts.port ?? config.port,
    websocket: bridge.handler,
    async fetch(req, server) {
      const ip = requestIP(req, server);
      if (!isLanAddress(ip)) {
        log("warn", "rejected non-LAN request", { ip });
        return new Response("Forbidden", { status: 403 });
      }

      const path = new URL(req.url).pathname;

      if (path === "/guest") return html(GUEST_PAGE_HTML);
      if (path === "/guest/session") return handleGuestSession(req);
      if (path === "/auth/token") return handleAuthToken(req);
      if (path === "/auth/authorize") return html(ACCESS_ENDED_HTML);
      if (path === "/admin" || path.startsWith("/admin/")) return handleAdmin(req, path, adminContext);
      if (path === "/api/websocket") {
        return server.upgrade(req, { data: initialSocketData() }) ? undefined : new Response("Upgrade required", { status: 426 });
      }

      const kind = classifyRequest(req.method, path, isDashboard);
      if (kind === "static") return forwardToHA(req, config, { withToken: false });
      if (kind === "deny") {
        log("warn", "rest denied", { method: req.method, path });
        return notFound(req);
      }

      const session = await sessionFor(req);
      if (!session) {
        log("warn", "rest guest auth rejected", { method: req.method, path });
        return json({ message: "Unauthorized" }, 401);
      }
      if (!session.scope.canView(kind.entityId)) {
        log("warn", "rest denied", { method: req.method, path });
        return notFound(req);
      }
      return forwardToHA(req, config, { withToken: true });
    },
  });
}
