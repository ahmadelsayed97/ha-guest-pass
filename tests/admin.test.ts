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
const ingress = (path: string) => new URL(path, h.ingressUrl);
const asUser = (id: string, init: RequestInit = {}) => ({
  ...init,
  headers: { ...(init.headers as Record<string, string>), "x-remote-user-id": id, "x-remote-user-name": id, "content-type": "application/json" },
});
const definition = { dashboards: ["lovelace-guest"], areas: { kitchen: "control" }, entities: {} };

describe("admin auth", () => {
  test.each([
    ["GET", "/admin/api/guests"],
    ["GET", "/admin/api/options"],
    ["POST", "/admin/api/preview"],
    ["POST", "/admin/api/guests"],
    ["DELETE", "/admin/api/guests/x"],
    ["POST", "/admin/api/guests/x/renew"],
  ])("%s %s without the admin secret is 401", async (method, path) => {
    expect((await fetch(url(path), { method })).status).toBe(401);
    expect((await fetch(url(path), { method, headers: { authorization: `Bearer ${h.token}` } })).status).toBe(401);
    expect((await fetch(url(path), { method, headers: { authorization: `Bearer ${ADMIN_SECRET.slice(0, -1)}x` } })).status).toBe(401);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("repeated wrong secrets lock the address out, correct secret included", async () => {
    const wrong = { headers: { authorization: "Bearer nope" } };
    for (let i = 0; i < 10; i++) expect((await fetch(url("/admin/api/guests"), wrong)).status).toBe(401);
    const blocked = await fetch(url("/admin/api/guests"), admin());
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  test("a locked out address can still open the admin page", async () => {
    const wrong = { headers: { authorization: "Bearer nope" } };
    for (let i = 0; i < 10; i++) await fetch(url("/admin/api/guests"), wrong);
    expect((await fetch(url("/admin"))).status).toBe(200);
  });

  test("a successful request clears the failures", async () => {
    const wrong = { headers: { authorization: "Bearer nope" } };
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 9; i++) await fetch(url("/admin/api/guests"), wrong);
      expect((await fetch(url("/admin/api/guests"), admin())).status).toBe(200);
    }
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
      guestPort: Number(h.proxyUrl.port),
      areas: [{ id: "kitchen", name: "Kitchen" }],
      dashboards: ["lovelace"],
      devices: [{ id: "dev-1", name: "Fridge", area: "kitchen" }],
      entities: [
        { id: "light.kitchen", name: "Kitchen", area: "kitchen", device: null },
        { id: "sensor.temp", name: "sensor.temp", area: "kitchen", device: "dev-1" },
      ],
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

  describe("renew", () => {
    const renew = (id: string, body: Record<string, unknown> = { durationMinutes: 120, origin: "http://proxy.lan:8124" }) =>
      fetch(url(`/admin/api/guests/${id}/renew`), admin({ method: "POST", body: JSON.stringify(body) }));

    test("a revoked guest gets a new record with the same name and scope and a new link", async () => {
      await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }));
      const res = await renew(h.guest.id);
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.guest.id).not.toBe(h.guest.id);
      expect(body.guest).toMatchObject({ name: h.guest.name, revokedAt: null, definition: h.guest.definition, entityCount: 3 });
      expect(body.guest.expiresAt - body.guest.createdAt).toBe(120 * 60_000);
      expect(body.link).toMatch(/^http:\/\/proxy\.lan:8124\/guest#eyJ/);
      expect(h.store.get(body.guest.id)?.scope).toEqual(h.guest.scope);
      expect(h.store.get(h.guest.id)?.revokedAt).toBeNumber();
    });

    test("the new link works and the old one stays dead", async () => {
      await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }));
      const { link } = await (await renew(h.guest.id)).json();
      const fresh = await fetch(url("/guest/session"), { headers: { authorization: `Bearer ${link.split("#")[1]}` } });
      expect(fresh.status).toBe(200);
      const old = await fetch(url("/guest/session"), { headers: { authorization: `Bearer ${h.token}` } });
      expect(old.status).toBe(401);
    });

    test("an expired guest can be renewed", async () => {
      const expired = h.store.create({ name: "Old", expiresAt: Date.now() - 1000, definition: h.guest.definition, scope: h.guest.scope });
      expect((await renew(expired.id)).status).toBe(201);
    });

    test("an active guest cannot be renewed", async () => {
      expect((await renew(h.guest.id)).status).toBe(409);
      expect(h.store.list()).toHaveLength(1);
    });

    test("an unknown guest is 404", async () => {
      expect((await renew("nope")).status).toBe(404);
    });

    test("duration and origin are validated like create", async () => {
      await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }));
      expect((await renew(h.guest.id, { durationMinutes: 0, origin: "http://proxy.lan:8124" })).status).toBe(400);
      expect((await renew(h.guest.id, { durationMinutes: 60, origin: "javascript:alert(1)" })).status).toBe(400);
    });
  });

  test("revoke marks the guest and a second revoke is 404", async () => {
    expect((await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }))).status).toBe(200);
    expect(h.store.get(h.guest.id)?.revokedAt).toBeNumber();
    expect((await fetch(url(`/admin/api/guests/${h.guest.id}`), admin({ method: "DELETE" }))).status).toBe(404);
    expect((await fetch(url("/admin/api/guests/nope"), admin({ method: "DELETE" }))).status).toBe(404);
  });
});

describe("ingress", () => {
  test("an admin user identified by Supervisor gets in without any secret", async () => {
    const res = await fetch(ingress("/admin/api/guests"), asUser("owner-1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });

  test("an admin user can create and revoke guests", async () => {
    const created = await fetch(
      ingress("/admin/api/guests"),
      asUser("owner-1", { method: "POST", body: JSON.stringify({ name: "Via ingress", durationMinutes: 30, origin: "http://ha.local:8124", definition }) }),
    );
    expect(created.status).toBe(201);
    const { guest, link } = await created.json();
    expect(link.startsWith("http://ha.local:8124/guest#")).toBe(true);
    const revoked = await fetch(ingress(`/admin/api/guests/${guest.id}`), asUser("owner-1", { method: "DELETE" }));
    expect(revoked.status).toBe(200);
  });

  test("a non-admin Home Assistant user is refused", async () => {
    const res = await fetch(ingress("/admin/api/guests"), asUser("kid-2"));
    expect(res.status).toBe(403);
  });

  test("a deactivated administrator is refused", async () => {
    const res = await fetch(ingress("/admin/api/guests"), asUser("gone-3"));
    expect(res.status).toBe(403);
  });

  test("an unknown user id is refused", async () => {
    const res = await fetch(ingress("/admin/api/guests"), asUser("nobody-9"));
    expect(res.status).toBe(403);
  });

  test("a request without a Supervisor identity is refused", async () => {
    expect((await fetch(ingress("/admin/api/guests"))).status).toBe(401);
    expect((await fetch(ingress("/admin/api/guests"), admin())).status).toBe(401);
  });

  test("the identity headers mean nothing on the public port", async () => {
    const res = await fetch(url("/admin/api/guests"), asUser("owner-1"));
    expect(res.status).toBe(401);
    expect(h.ha.received.map((m) => m.type)).not.toContain("config/auth/list");
  });

  test("the ingress page is served and calls its API by relative path", async () => {
    const res = await fetch(ingress("/admin"), asUser("owner-1"));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('"admin/api"');
    expect(html).not.toContain('"/admin/api"');
  });

  test("options tell the page which port guests use", async () => {
    const res = await fetch(ingress("/admin/api/options"), asUser("owner-1"));
    expect((await res.json()).guestPort).toBe(Number(h.proxyUrl.port));
  });
});

describe("ingress from the wrong peer", () => {
  let wrong: Harness;
  beforeEach(async () => {
    wrong = await startHarness("192.168.1.50", 3600_000, "192.168.1.77");
  });
  afterEach(() => wrong.stop());

  test("a LAN client spoofing the identity headers is refused", async () => {
    const res = await fetch(new URL("/admin/api/guests", wrong.ingressUrl), asUser("owner-1"));
    expect(res.status).toBe(403);
    expect(wrong.ha.received.map((m) => m.type)).not.toContain("config/auth/list");
  });
});
