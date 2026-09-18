import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ADMIN_SECRET, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(() => h.stop());

const admin = (init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${ADMIN_SECRET}`, "content-type": "application/json" },
});
const url = (path: string) => new URL(path, h.proxyUrl);
const definition = { dashboards: ["lovelace-guest"], areas: { kitchen: "control" }, entities: {} };

describe("admin auth", () => {
  test.each([
    ["GET", "/admin/api/guests"],
    ["GET", "/admin/api/options"],
    ["POST", "/admin/api/preview"],
    ["POST", "/admin/api/guests"],
    ["DELETE", "/admin/api/guests/x"],
  ])("%s %s without the admin secret is 401", async (method, path) => {
    expect((await fetch(url(path), { method })).status).toBe(401);
    expect((await fetch(url(path), { method, headers: { authorization: `Bearer ${h.token}` } })).status).toBe(401);
    expect((await fetch(url(path), { method, headers: { authorization: `Bearer ${ADMIN_SECRET.slice(0, -1)}x` } })).status).toBe(401);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("the admin page itself is served without auth but holds no secrets", async () => {
    const res = await fetch(url("/admin"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(ADMIN_SECRET);
    expect(html).not.toContain(h.ha.token);
  });

  test("the admin secret is not a guest credential", async () => {
    const res = await fetch(url("/guest/session"), { headers: { authorization: `Bearer ${ADMIN_SECRET}` } });
    expect(res.status).toBe(401);
  });
});

describe("admin api", () => {
  test("options dedupes the default dashboard when HA lists it", async () => {
    h.ha.dashboards = [{ url_path: "lovelace" }, { url_path: "map" }];
    const res = await fetch(url("/admin/api/options"), admin());
    expect((await res.json()).dashboards).toEqual(["lovelace", "map"]);
  });

  test("options lists areas, dashboards and entities from HA", async () => {
    const res = await fetch(url("/admin/api/options"), admin());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      areas: [{ id: "kitchen", name: "Kitchen" }],
      dashboards: ["lovelace"],
      entities: ["light.kitchen", "sensor.temp"],
    });
  });

  test("preview resolves a definition without creating anything", async () => {
    const res = await fetch(url("/admin/api/preview"), admin({ method: "POST", body: JSON.stringify(definition) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dashboards: ["lovelace-guest"],
      entities: { "light.kitchen": "control", "sensor.temp": "view" },
      sources: { "light.kitchen": "area:kitchen", "sensor.temp": "area:kitchen" },
    });
    expect(h.store.list()).toHaveLength(1);
  });

  test("preview with a bad definition is 400", async () => {
    const res = await fetch(url("/admin/api/preview"), admin({ method: "POST", body: JSON.stringify({ dashboards: [], areas: { attic: "view" } }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown area: attic" });
  });

  test("create stores the guest and returns a working link and a qr", async () => {
    const res = await fetch(
      url("/admin/api/guests"),
      admin({ method: "POST", body: JSON.stringify({ name: "Ada", durationMinutes: 90, definition, origin: "http://proxy.lan:8124" }) }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.guest).toMatchObject({ name: "Ada", revokedAt: null });
    expect(body.guest.expiresAt - body.guest.createdAt).toBe(90 * 60_000);
    expect(body.link).toMatch(/^http:\/\/proxy\.lan:8124\/guest#eyJ/);
    expect(body.qrSvg).toContain("<svg");
    expect(body.guest).not.toHaveProperty("scope");
    expect(body.guest).not.toHaveProperty("tokenId");

    const token = body.link.split("#")[1];
    const session = await fetch(url("/guest/session"), { headers: { authorization: `Bearer ${token}` } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ name: "Ada", dashboards: ["lovelace-guest"] });
    expect(h.store.get(body.guest.id)?.scope).toEqual({ dashboards: ["lovelace-guest"], entities: { "light.kitchen": "control", "sensor.temp": "view" } });
  });

  test.each([
    [{ name: "", durationMinutes: 60, definition, origin: "http://p" }, "empty name"],
    [{ name: "A", durationMinutes: 0, definition, origin: "http://p" }, "zero duration"],
    [{ name: "A", durationMinutes: 60 * 24 * 400, definition, origin: "http://p" }, "over a year"],
    [{ name: "A", durationMinutes: "60", definition, origin: "http://p" }, "string duration"],
    [{ name: "A", durationMinutes: 60, definition: {}, origin: "http://p" }, "bad definition"],
    [{ name: "A", durationMinutes: 60, definition, origin: "javascript:alert(1)" }, "bad origin"],
    [{ name: "A", durationMinutes: 60, definition, origin: "http://p/path" }, "origin with path"],
    [{ name: "A", durationMinutes: 60, definition }, "no origin"],
  ])("create rejects %p (%s)", async (body) => {
    const res = await fetch(url("/admin/api/guests"), admin({ method: "POST", body: JSON.stringify(body) }));
    expect(res.status).toBe(400);
    expect(h.store.list()).toHaveLength(1);
  });

  test("list shows guests without scopes or token ids, newest first", async () => {
    await fetch(url("/admin/api/guests"), admin({ method: "POST", body: JSON.stringify({ name: "Ada", durationMinutes: 60, definition, origin: "http://p" }) }));
    const res = await fetch(url("/admin/api/guests"), admin());
    const guests = await res.json();
    expect(guests.map((g: { name: string }) => g.name)).toEqual(["Ada", "Guest"]);
    for (const g of guests) {
      expect(g).not.toHaveProperty("scope");
      expect(g).not.toHaveProperty("tokenId");
      expect(g).toHaveProperty("entityCount");
    }
  });

  test("revoke marks the guest and a second revoke is 404", async () => {
    expect((await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }))).status).toBe(200);
    expect(h.store.get(h.guest.id)?.revokedAt).toBeNumber();
    expect((await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }))).status).toBe(404);
    expect((await fetch(url("/admin/api/guests/nope"), admin({ method: "DELETE" }))).status).toBe(404);
  });
});
