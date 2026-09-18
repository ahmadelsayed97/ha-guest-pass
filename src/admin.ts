import QRCode from "qrcode";
import type { Config } from "./config.ts";
import { bearerToken, constantTimeEquals } from "./guest-auth.ts";
import type { Guest, GuestStore } from "./guest-store.ts";
import { fetchRegistries, HAClient } from "./ha-client.ts";
import type { Logger } from "./log.ts";
import { ADMIN_PAGE_HTML } from "./admin-page.ts";
import { resolveScope } from "./resolve.ts";
import { parseScopeDefinition, type ScopeDefinition } from "./scope-definition.ts";
import { html, json } from "./server.ts";
import { signGuestToken } from "./token.ts";

export interface AdminContext {
  config: Config;
  store: GuestStore;
  log: Logger;
  onRevoked(guestId: string): void;
}

const MAX_NAME_LENGTH = 64;
const MAX_DURATION_MINUTES = 366 * 24 * 60;

class BadRequest extends Error {}

function publicView(guest: Guest) {
  return {
    id: guest.id,
    name: guest.name,
    createdAt: guest.createdAt,
    expiresAt: guest.expiresAt,
    revokedAt: guest.revokedAt,
    definition: guest.definition,
    dashboards: guest.scope.dashboards,
    entityCount: Object.keys(guest.scope.entities).length,
  };
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequest("body must be JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BadRequest("body must be an object");
  return body as Record<string, unknown>;
}

function parseDefinition(input: unknown): ScopeDefinition {
  try {
    return parseScopeDefinition(input);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
}

function parseOrigin(input: unknown): string {
  if (typeof input !== "string") throw new BadRequest("origin is required");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequest("origin must be a URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new BadRequest("origin must be a bare http(s) origin");
  }
  return url.origin;
}

async function withHA<T>(config: Config, fn: (client: HAClient) => Promise<T>): Promise<T> {
  const client = await HAClient.connect(config);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

async function resolveDefinition(config: Config, definition: ScopeDefinition) {
  const registries = await withHA(config, fetchRegistries);
  try {
    return resolveScope(definition, registries);
  } catch (e) {
    throw new BadRequest((e as Error).message);
  }
}

async function options(config: Config): Promise<Response> {
  const data = await withHA(config, async (client) => {
    const [registries, dashboards] = await Promise.all([fetchRegistries(client), client.call("lovelace/dashboards/list")]);
    return { registries, dashboards: dashboards as Array<{ url_path: string }> };
  });
  return json({
    areas: data.registries.areas.map((a) => ({ id: a.area_id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
    dashboards: [...new Set(["lovelace", ...data.dashboards.map((d) => d.url_path)])],
    entities: data.registries.entities.map((e) => e.entity_id).sort(),
  });
}

async function preview(req: Request, config: Config): Promise<Response> {
  const definition = parseDefinition(await readJson(req));
  return json(await resolveDefinition(config, definition));
}

async function createGuest(req: Request, ctx: AdminContext): Promise<Response> {
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) throw new BadRequest("name must be 1-64 characters");
  const minutes = body.durationMinutes;
  if (!Number.isInteger(minutes) || (minutes as number) <= 0 || (minutes as number) > MAX_DURATION_MINUTES) {
    throw new BadRequest("durationMinutes must be a whole number of minutes, at most a year");
  }
  const origin = parseOrigin(body.origin);
  const definition = parseDefinition(body.definition);
  const { sources, ...scope } = await resolveDefinition(ctx.config, definition);

  const guest = ctx.store.create({ name, expiresAt: Date.now() + (minutes as number) * 60_000, definition, scope });
  const token = await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, ctx.config.signingKey);
  const link = `${origin}/guest#${token}`;
  const qrSvg = await QRCode.toString(link, { type: "svg", margin: 1 });
  ctx.log("info", "guest created", { guest: guest.id, entities: Object.keys(scope.entities).length, sources: Object.keys(sources).length });
  return json({ guest: publicView(guest), link, qrSvg }, 201);
}

function listGuests(store: GuestStore): Response {
  return json(
    store
      .list()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicView),
  );
}

function revokeGuest(id: string, ctx: AdminContext): Response {
  if (!ctx.store.revoke(id)) return json({ error: "no such active guest" }, 404);
  ctx.onRevoked(id);
  ctx.log("info", "guest revoked", { guest: id });
  return json({ ok: true });
}

function isAdmin(req: Request, config: Config): boolean {
  return constantTimeEquals(bearerToken(req.headers.get("authorization")), config.adminSecret);
}

export async function handleAdmin(req: Request, path: string, ctx: AdminContext): Promise<Response> {
  if (path === "/admin") return html(ADMIN_PAGE_HTML);
  if (!isAdmin(req, ctx.config)) return json({ message: "Unauthorized" }, 401);

  const route = `${req.method} ${path}`;
  try {
    if (route === "GET /admin/api/options") return await options(ctx.config);
    if (route === "POST /admin/api/preview") return await preview(req, ctx.config);
    if (route === "POST /admin/api/guests") return await createGuest(req, ctx);
    if (route === "GET /admin/api/guests") return listGuests(ctx.store);
    const revoke = /^DELETE \/admin\/api\/guests\/([A-Za-z0-9_-]+)$/.exec(route);
    if (revoke) return revokeGuest(revoke[1]!, ctx);
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    ctx.log("error", "admin request failed", { route, error: (e as Error).message });
    return json({ error: "Home Assistant request failed" }, 502);
  }
}
