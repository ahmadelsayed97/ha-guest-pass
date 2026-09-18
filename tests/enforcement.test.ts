import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { authenticatedSocket, GUEST_SECRET, startHarness, type Harness } from "./helpers.ts";

let h: Harness;
beforeEach(() => {
  h = startHarness();
});
afterEach(() => {
  h.stop();
});

const authed = () => ({ headers: { authorization: `Bearer ${GUEST_SECRET}` } });

describe("WebSocket enforcement", () => {
  test("get_states returns only scoped entities", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "get_states" }));
    const result = JSON.parse(await rec.next());
    expect(result.result.map((s: { entity_id: string }) => s.entity_id).sort()).toEqual(["light.kitchen", "sensor.temp"]);
    expect(JSON.stringify(rec.frames)).not.toContain("lock.front");
    ws.close();
  });

  test("subscribe_entities is rewritten to the scoped list and its events are filtered", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "subscribe_entities" }));
    const result = JSON.parse(await rec.next());
    expect(result).toEqual({ id: 1, type: "result", success: true, result: null });
    const event = JSON.parse(await rec.next());
    expect(Object.keys(event.event.a).sort()).toEqual(["light.kitchen", "sensor.temp"]);
    expect((h.ha.received[0]!.entity_ids as string[]).sort()).toEqual(["camera.front", "light.kitchen", "sensor.temp"]);
    ws.close();
  });

  test("call_service on a controllable entity reaches HA normalised", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "call_service", domain: "light", service: "turn_on", service_data: { entity_id: "light.kitchen", brightness: 3 } }));
    const result = JSON.parse(await rec.next());
    expect(result).toEqual({ id: 1, type: "result", success: true, result: { context: { id: "ctx" } } });
    expect(h.ha.received).toEqual([
      { id: 1, type: "call_service", domain: "light", service: "turn_on", target: { entity_id: ["light.kitchen"] }, service_data: { brightness: 3 } },
    ]);
    ws.close();
  });

  test.each([
    { domain: "sensor", service: "anything", target: { entity_id: "sensor.temp" } },
    { domain: "lock", service: "unlock", target: { entity_id: "lock.front" } },
    { domain: "light", service: "turn_on", target: { area_id: "kitchen" } },
    { domain: "homeassistant", service: "restart" },
  ])("call_service %p is refused locally and never reaches HA", async (call) => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "call_service", ...call }));
    const result = JSON.parse(await rec.next());
    expect(result).toMatchObject({ id: 1, type: "result", success: false, error: { code: "unauthorized" } });
    expect(h.ha.received).toHaveLength(0);
    ws.close();
  });

  test("unknown message types are refused locally and never reach HA", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "render_template", template: "{{ states.lock.front.attributes.code }}" }));
    const result = JSON.parse(await rec.next());
    expect(result).toMatchObject({ id: 1, success: false, error: { code: "unknown_command" } });
    expect(h.ha.received).toHaveLength(0);
    ws.close();
  });

  test("a frame without an id after auth closes the socket", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ type: "get_states" }));
    expect((await rec.closed).code).toBe(1008);
    expect(h.ha.received).toHaveLength(0);
  });

  test("unsolicited state_changed events from HA are filtered by scope", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
    await rec.next();
    h.ha.broadcast(JSON.stringify({ id: 1, type: "event", event: { event_type: "state_changed", data: { entity_id: "lock.front", new_state: { state: "unlocked" } } } }));
    h.ha.broadcast(JSON.stringify({ id: 1, type: "event", event: { event_type: "state_changed", data: { entity_id: "light.kitchen", new_state: { state: "off" } } } }));
    const event = JSON.parse(await rec.next());
    expect(event.event.data.entity_id).toBe("light.kitchen");
    expect(JSON.stringify(rec.frames)).not.toContain("lock.front");
    ws.close();
  });

  test("events for ids the guest never subscribed to are dropped", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    h.ha.broadcast(JSON.stringify({ id: 77, type: "event", event: { event_type: "state_changed", data: { entity_id: "light.kitchen" } } }));
    ws.send(JSON.stringify({ id: 1, type: "ping" }));
    expect(JSON.parse(await rec.next())).toEqual({ id: 1, type: "pong" });
    expect(rec.frames.filter((f) => f.includes('"id":77'))).toHaveLength(0);
    ws.close();
  });

  test("a coalesced array frame from HA closes the guest socket", async () => {
    const { rec } = await authenticatedSocket(h);
    h.ha.broadcast(JSON.stringify([{ id: 1, type: "pong" }]));
    expect((await rec.closed).code).toBe(1011);
  });

  test("an unparseable frame from HA closes the guest socket", async () => {
    const { rec } = await authenticatedSocket(h);
    h.ha.broadcast("{not json");
    expect((await rec.closed).code).toBe(1011);
  });

  test("silent subscriptions never reach HA and can be unsubscribed", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "service_registry_updated" }));
    expect(JSON.parse(await rec.next())).toEqual({ id: 1, type: "result", success: true, result: null });
    ws.send(JSON.stringify({ id: 2, type: "unsubscribe_events", subscription: 1 }));
    expect(JSON.parse(await rec.next())).toEqual({ id: 2, type: "result", success: true, result: null });
    expect(h.ha.received).toHaveLength(0);
    ws.close();
  });

  test("auth/current_user never reaches HA and reports a non-admin", async () => {
    const { ws, rec } = await authenticatedSocket(h);
    ws.send(JSON.stringify({ id: 1, type: "auth/current_user" }));
    const result = JSON.parse(await rec.next());
    expect(result.result.is_admin).toBe(false);
    expect(h.ha.received).toHaveLength(0);
    ws.close();
  });
});

describe("HTTP enforcement", () => {
  test.each(["/config", "/developer-tools/state", "/history", "/profile", "/lovelace", "/lovelace-private"])("%s is 404 without contacting HA", async (path) => {
    const res = await fetch(new URL(path, h.proxyUrl), authed());
    expect(res.status).toBe(404);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("scoped dashboard path is served", async () => {
    const res = await fetch(new URL("/lovelace-guest/0", h.proxyUrl));
    expect(res.status).toBe(200);
    expect(h.ha.httpAuth).toEqual([{ path: "/lovelace-guest/0", authorization: null }]);
  });

  test.each(["/api/states", "/api/states/light.kitchen", "/api/history/period", "/api/template", "/api/camera_proxy/camera.back", "/api/config"])(
    "%s is 404 even with a valid guest credential",
    async (path) => {
      const res = await fetch(new URL(path, h.proxyUrl), authed());
      expect(res.status).toBe(404);
      expect(h.ha.httpAuth).toHaveLength(0);
    },
  );

  test("POST to a static path is refused", async () => {
    const res = await fetch(new URL("/static/x.js", h.proxyUrl), { method: "POST", body: "x" });
    expect(res.status).toBe(404);
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test("guest page asks the proxy for its session before signing in", async () => {
    const html = await (await fetch(new URL("/guest", h.proxyUrl))).text();
    expect(html).toContain("/guest/session");
    expect(html).toContain("defaultPanel");
    expect(html).not.toContain("lovelace-guest");
  });

  test("/guest/session describes the guest and its dashboards", async () => {
    const res = await fetch(new URL("/guest/session", h.proxyUrl), authed());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "Guest", dashboards: ["lovelace-guest"] });
    expect(h.ha.httpAuth).toHaveLength(0);
  });

  test.each<Record<string, string>>([{}, { authorization: "Bearer wrong" }])("/guest/session without a valid credential is 401 (%p)", async (headers) => {
    const res = await fetch(new URL("/guest/session", h.proxyUrl), { headers });
    expect(res.status).toBe(401);
  });
});
