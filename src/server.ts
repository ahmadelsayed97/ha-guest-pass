import type { Server } from "bun";
import { handleAdmin, type AdminContext, type AdminIdentity } from "./admin.ts";
import type { Config } from "./config.ts";
import { bearerToken, type Authenticator, type Session } from "./guest-auth.ts";
import type { GuestStore } from "./guest-store.ts";
import { isAdminUser } from "./ha-client.ts";
import { EXPIRY_SCRIPT_PATH, withExpiryNotice } from "./expiry-notice.ts";
import { classifyRequest } from "./http-policy.ts";
import { forwardToHA } from "./http-proxy.ts";
import { isLanAddress } from "./lan.ts";
import { consoleLogger, type Logger } from "./log.ts";
import { page, script } from "./pages.ts";
import {
  ADMIN_FAILURE_LIMIT,
  ADMIN_WINDOW_MS,
  createRateLimiter,
  GUEST_FAILURE_LIMIT,
  GUEST_WINDOW_MS,
} from "./rate-limit.ts";
import { createGuestBridge, initialSocketData, type GuestSocketData } from "./ws-proxy.ts";

export interface ServerDeps {
  auth: Authenticator;
  store: GuestStore;
}

export interface IngressOptions {
  hostname: string;
  port: number;
  supervisorAddress: string;
  requestIP?: (req: Request, server: Server<undefined>) => string | null;
}

export interface ServerOptions {
  log?: Logger;
  port?: number;
  requestIP?: (req: Request, server: Server<GuestSocketData>) => string | null;
  ingress?: IngressOptions;
}

export interface Proxy {
  server: Server<GuestSocketData>;
  ingress: Server<undefined> | null;
  stop(): void;
}

const REMOTE_USER_ID = "x-remote-user-id";
const REMOTE_USER_NAME = "x-remote-user-display-name";

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function tooManyRequests(retryAfterMs: number): Response {
  const retryAfter = String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
  return new Response("Too many requests", { status: 429, headers: { "retry-after": retryAfter } });
}

function notFound(req: Request): Response {
  const wantsPage = req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html");
  return wantsPage ? page("not-available.html", 404) : new Response("Not found", { status: 404 });
}

export function createServer(config: Config, deps: ServerDeps, opts: ServerOptions = {}): Proxy {
  const { auth, store } = deps;
  const log = opts.log ?? consoleLogger;
  const requestIP = opts.requestIP ?? ((req, server) => server.requestIP(req)?.address ?? null);
  const adminLimiter = createRateLimiter({ limit: ADMIN_FAILURE_LIMIT, windowMs: ADMIN_WINDOW_MS });
  const guestLimiter = createRateLimiter({ limit: GUEST_FAILURE_LIMIT, windowMs: GUEST_WINDOW_MS });
  const bridge = createGuestBridge(config, auth, log, guestLimiter);
  const isDashboard = (urlPath: string) => auth.dashboards().includes(urlPath);
  const adminContext: AdminContext = {
    config,
    store,
    log,
    guestPort: () => server.port ?? config.port,
    onRevoked: (guestId) => bridge.closeSessionsOf(guestId),
  };

  async function sessionFor(req: Request, ip: string): Promise<Session | null> {
    const session = await auth.authenticate(bearerToken(req.headers.get("authorization")));
    if (session) guestLimiter.clear(ip);
    else guestLimiter.recordFailure(ip);
    return session;
  }

  async function guestRequest(req: Request, ip: string, handle: (session: Session) => Response | Promise<Response>): Promise<Response> {
    const retryAfterMs = guestLimiter.retryAfterMs(ip);
    if (retryAfterMs > 0) {
      log("warn", "rest guest auth rate limited", { ip });
      return tooManyRequests(retryAfterMs);
    }
    const session = await sessionFor(req, ip);
    if (!session) {
      log("warn", "rest guest auth rejected", { method: req.method, path: new URL(req.url).pathname });
      return json({ message: "Unauthorized" }, 401);
    }
    return handle(session);
  }

  async function handleAdminRequest(req: Request, path: string, ip: string): Promise<Response> {
    if (path === "/admin") return handleAdmin(req, path, adminContext);
    const retryAfterMs = adminLimiter.retryAfterMs(ip);
    if (retryAfterMs > 0) {
      log("warn", "admin auth rate limited", { ip });
      return tooManyRequests(retryAfterMs);
    }
    const res = await handleAdmin(req, path, adminContext);
    if (res.status === 401) adminLimiter.recordFailure(ip);
    else adminLimiter.clear(ip);
    return res;
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

  function handleGuestSession(req: Request, ip: string): Promise<Response> {
    return guestRequest(req, ip, (session) =>
      json({ name: session.user.name, dashboards: session.scope.dashboards(), expiresAt: session.expiresAt }),
    );
  }

  function ingressServer(ingress: IngressOptions): Server<undefined> {
    const requestIP = ingress.requestIP ?? ((req, server) => server.requestIP(req)?.address ?? null);
    return Bun.serve<undefined>({
      hostname: ingress.hostname,
      port: ingress.port,
      async fetch(req, server) {
        const ip = requestIP(req, server);
        if (ip !== ingress.supervisorAddress) {
          log("warn", "ingress request not from Supervisor", { ip });
          return new Response("Forbidden", { status: 403 });
        }
        const userId = req.headers.get(REMOTE_USER_ID);
        if (!userId) return json({ message: "Unauthorized" }, 401);
        if (!(await isAdminUser(config, userId))) {
          log("warn", "ingress user is not an administrator", { user: userId });
          return json({ message: "Forbidden" }, 403);
        }
        const identity: AdminIdentity = { id: userId, name: req.headers.get(REMOTE_USER_NAME) ?? userId };
        return handleAdmin(req, new URL(req.url).pathname, adminContext, identity);
      },
    });
  }

  const server = Bun.serve<GuestSocketData>({
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

      if (path === "/health") return json({ status: "ok" });
      if (path === "/guest") return page("guest.html");
      if (path === EXPIRY_SCRIPT_PATH) return script("expiry.js");
      if (path === "/guest/session") return handleGuestSession(req, ip);
      if (path === "/auth/token") return handleAuthToken(req);
      if (path === "/auth/authorize") return page("access-ended.html");
      if (path === "/admin" || path.startsWith("/admin/")) return handleAdminRequest(req, path, ip);
      if (path === "/api/websocket") {
        return server.upgrade(req, { data: initialSocketData(ip) }) ? undefined : new Response("Upgrade required", { status: 426 });
      }

      const kind = classifyRequest(req.method, path, isDashboard);
      if (kind === "static") return withExpiryNotice(await forwardToHA(req, config, { withToken: false }));
      if (kind === "deny") {
        log("warn", "rest denied", { method: req.method, path });
        return notFound(req);
      }

      return guestRequest(req, ip, (session) => {
        if (!session.scope.canView(kind.entityId)) {
          log("warn", "rest denied", { method: req.method, path });
          return notFound(req);
        }
        return forwardToHA(req, config, { withToken: true });
      });
    },
  });

  const ingress = opts.ingress ? ingressServer(opts.ingress) : null;
  return {
    server,
    ingress,
    stop() {
      server.stop(true);
      ingress?.stop(true);
    },
  };
}
