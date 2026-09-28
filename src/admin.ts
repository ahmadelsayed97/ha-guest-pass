import QRCode from "qrcode";
import type { Config } from "./config.ts";
import { bearerToken, constantTimeEquals } from "./guest-auth.ts";
import type { Guest, GuestStore } from "./guest-store.ts";
import { fetchRegistries, HAClient } from "./ha-client.ts";
import type { Logger } from "./log.ts";
import { resolveScope, selectableEntities } from "./resolve.ts";
import { parseScopeDefinition, type ScopeDefinition } from "./scope-definition.ts";
import { page } from "./pages.ts";
import { json } from "./server.ts";
import { signGuestToken } from "./token.ts";

export interface AdminContext {
  config: Config;
  store: GuestStore;
  log: Logger;
  guestPort(): number;
  onRevoked(guestId: string): void;
}

export interface AdminIdentity {
  id: string;
  name: string;
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

function friendlyNames(states: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!Array.isArray(states)) return names;
  for (const state of states) {
    if (typeof state !== "object" || state === null) continue;
    const { entity_id, attributes } = state as { entity_id?: unknown; attributes?: { friendly_name?: unknown } };
    if (typeof entity_id === "string" && typeof attributes?.friendly_name === "string") names.set(entity_id, attributes.friendly_name);
  }
  return names;
}

async function options(ctx: AdminContext): Promise<Response> {
  const data = await withHA(ctx.config, async (client) => {
    const [registries, dashboards, states] = await Promise.all([
      fetchRegistries(client),
      client.call("lovelace/dashboards/list"),
      client.call("get_states"),
    ]);
    return { registries, dashboards: dashboards as Array<{ url_path: string }>, names: friendlyNames(states) };
  });
  const byName = (a: { name: string; id: string }, b: { name: string; id: string }) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const entities = selectableEntities(data.registries)
    .map(({ entityId, areaId, deviceId }) => ({ id: entityId, name: data.names.get(entityId) ?? entityId, area: areaId, device: deviceId }))
    .sort(byName);
  const used = new Set(entities.map((e) => e.device));
  const devices = data.registries.devices
    .filter((d) => used.has(d.id))
    .map((d) => ({ id: d.id, name: d.name_by_user || d.name || d.id, area: d.area_id }))
    .sort(byName);
  return json({
    guestPort: ctx.guestPort(),
    areas: data.registries.areas.map((a) => ({ id: a.area_id, name: a.name })).sort((a, b) => a.name.localeCompare(b.name)),
    dashboards: [...new Set(["lovelace", ...data.dashboards.map((d) => d.url_path)])],
    devices,
    entities,
  });
}

async function preview(req: Request, config: Config): Promise<Response> {
  const definition = parseDefinition(await readJson(req));
  return json(await resolveDefinition(config, definition));
}

function parseDurationMinutes(input: unknown): number {
  if (!Number.isInteger(input) || (input as number) <= 0 || (input as number) > MAX_DURATION_MINUTES) {
    throw new BadRequest("durationMinutes must be a whole number of minutes, at most a year");
  }
  return input as number;
}

async function issued(guest: Guest, origin: string, config: Config): Promise<Response> {
  const token = await signGuestToken({ guestId: guest.id, tokenId: guest.tokenId, expiresAt: guest.expiresAt }, config.signingKey);
  const link = `${origin}/guest#${token}`;
  const qrSvg = await QRCode.toString(link, { type: "svg", margin: 1 });
  return json({ guest: publicView(guest), link, qrSvg }, 201);
}

async function createGuest(req: Request, ctx: AdminContext, by: string): Promise<Response> {
  const body = await readJson(req);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) throw new BadRequest("name must be 1-64 characters");
  const minutes = parseDurationMinutes(body.durationMinutes);
  const origin = parseOrigin(body.origin);
  const definition = parseDefinition(body.definition);
  const { sources, ...scope } = await resolveDefinition(ctx.config, definition);

  const guest = ctx.store.create({ name, expiresAt: Date.now() + minutes * 60_000, definition, scope });
  ctx.log("info", "guest created", { guest: guest.id, by, entities: Object.keys(scope.entities).length, sources: Object.keys(sources).length });
  return issued(guest, origin, ctx.config);
}

async function renewGuest(req: Request, id: string, ctx: AdminContext, by: string): Promise<Response> {
  const body = await readJson(req);
  const minutes = parseDurationMinutes(body.durationMinutes);
  const origin = parseOrigin(body.origin);
  const previous = ctx.store.get(id);
  if (!previous) return json({ error: "no such guest" }, 404);
  if (previous.revokedAt === null && previous.expiresAt > Date.now()) return json({ error: "guest is still active; revoke it first" }, 409);

  const guest = ctx.store.renew(id, Date.now() + minutes * 60_000)!;
  ctx.log("info", "guest renewed", { guest: guest.id, from: id, by });
  return issued(guest, origin, ctx.config);
}

function listGuests(store: GuestStore): Response {
  return json(
    store
      .list()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicView),
  );
}

function revokeGuest(id: string, ctx: AdminContext, by: string): Response {
  if (!ctx.store.revoke(id)) return json({ error: "no such active guest" }, 404);
  ctx.onRevoked(id);
  ctx.log("info", "guest revoked", { guest: id, by });
  return json({ ok: true });
}

function isAdmin(req: Request, config: Config): boolean {
  return constantTimeEquals(bearerToken(req.headers.get("authorization")), config.adminSecret);
}

export async function handleAdmin(req: Request, path: string, ctx: AdminContext, identity?: AdminIdentity): Promise<Response> {
  if (path === "/admin") return page("admin.html");
  if (!identity && !isAdmin(req, ctx.config)) return json({ message: "Unauthorized" }, 401);
  const by = identity ? identity.id : "secret";

  const route = `${req.method} ${path}`;
  try {
    if (route === "GET /admin/api/options") return await options(ctx);
    if (route === "POST /admin/api/preview") return await preview(req, ctx.config);
    if (route === "POST /admin/api/guests") return await createGuest(req, ctx, by);
    if (route === "GET /admin/api/guests") return listGuests(ctx.store);
    const revoke = /^DELETE \/admin\/api\/guests\/([A-Za-z0-9_-]+)$/.exec(route);
    if (revoke) return revokeGuest(revoke[1]!, ctx, by);
    const renew = /^POST \/admin\/api\/guests\/([A-Za-z0-9_-]+)\/renew$/.exec(route);
    if (renew) return await renewGuest(req, renew[1]!, ctx, by);
    return json({ error: "not found" }, 404);
  } catch (e) {
    if (e instanceof BadRequest) return json({ error: e.message }, 400);
    ctx.log("error", "admin request failed", { route, error: (e as Error).message });
    return json({ error: "Home Assistant request failed" }, 502);
  }
}
